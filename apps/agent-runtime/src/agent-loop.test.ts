import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPayload } from '@ventus/audit';
import { FileAuditStore, FileProposalStore } from '@ventus/store';
import { auditedExecutor } from './audited-executor.js';
import { FakeAgentRuntime } from './fake-runtime.js';
import {
  CREATE_PROPOSAL_TOOL,
  withProposalTool,
} from './proposal-tool.js';
import {
  ExecutorRegistry,
  executeProposal,
  MockEmailExecutor,
} from './executors/index.js';
import type { RunStepEvent, ToolDefinition, ToolExecutor } from './runtime.js';

// End-to-end coverage of the Tier 2 path WITHOUT calling Anthropic:
//
//   FakeAgentRuntime (scripted)
//     → withProposalTool (routes create_proposal to FileProposalStore)
//     → auditedExecutor   (records intent + outcome per tool call)
//   Then, simulating a reviewer in the inbox:
//     → store.decide(approved)
//     → executeProposal → MockEmailExecutor → outbox + audit outcome
//
// Every layer is real except the LLM. Asserts on what landed in proposals,
// audit_trail, and outbox so a regression at any layer trips a test.

const TENANT = '00000000-0000-0000-0000-00000000000a';
const RUN_ID = 'run-e2e-1';
const AGENT_ID = 'agent-e2e-1';

describe('agent loop (scripted fake runtime → proposal → reviewer → executor)', () => {
  let dir: string;
  let proposalsPath: string;
  let auditPath: string;
  let outboxPath: string;
  let proposals: FileProposalStore;
  let audit: FileAuditStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-e2e-'));
    proposalsPath = join(dir, 'proposals.json');
    auditPath = join(dir, 'audit.json');
    outboxPath = join(dir, 'outbox.json');
    proposals = new FileProposalStore(proposalsPath);
    audit = new FileAuditStore(auditPath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function runAgent(turns: ConstructorParameters<typeof FakeAgentRuntime>[0]['turns']) {
    const baseExecutor: ToolExecutor = async (name) => {
      throw new Error(`unexpected base tool call: ${name}`);
    };
    const composed = auditedExecutor(
      withProposalTool(baseExecutor, {
        proposals,
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      { audit, tenantId: TENANT, runId: RUN_ID, agentId: AGENT_ID },
    );
    const tools: ToolDefinition[] = [CREATE_PROPOSAL_TOOL];
    const runtime = new FakeAgentRuntime({ turns });
    return collect(
      runtime.run({
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'test agent',
        userMessage: 'draft a reply to doc-1',
        tools,
        toolExecutor: composed,
        maxSteps: 5,
        maxTokens: 1000,
      }),
    );
  }

  it('agent calls create_proposal → proposal lands in pending → audit records intent+outcome', async () => {
    const events = await runAgent([
      {
        tools: [
          {
            name: 'create_proposal',
            input: {
              action_type: 'draft_email_reply',
              resource_type: 'email',
              resource_id: 'doc-1',
              payload: {
                to: 'customer@example.com',
                subject: 'Re: order #1234',
                body: 'Hi! Your order shipped this morning.',
              },
              evidence: [
                {
                  document_id: 'doc-1',
                  quote: 'when will my order ship',
                  rationale: 'customer asked about shipping',
                },
              ],
              expected_outcome: 'Customer informed about shipping',
              confidence: 0.85,
            },
          },
        ],
        tokensIn: 100,
        tokensOut: 50,
      },
      { text: 'Draft staged.' },
    ]);

    // Exact event sequence: step_started, assistant_message(tool_use),
    // tool_call, tool_result, step_started, assistant_message(end_turn), completed.
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'step_started',
      'assistant_message',
      'tool_call',
      'tool_result',
      'step_started',
      'assistant_message',
      'completed',
    ]);

    // tool_call → tool_result id chain
    const toolCall = events.find((e) => e.type === 'tool_call');
    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolCall?.type !== 'tool_call' || toolResult?.type !== 'tool_result') {
      throw new Error('missing tool_call/tool_result');
    }
    expect(toolCall.name).toBe('create_proposal');
    expect(toolCall.id).toBe(toolResult.id);
    expect(toolResult.isError).toBe(false);
    expect(
      (toolResult.result as { proposal_id: string }).proposal_id,
    ).toMatch(/^[0-9a-f-]{36}$/);

    // completion event has the scripted final text
    const completed = events.find((e) => e.type === 'completed');
    if (completed?.type !== 'completed') throw new Error('missing completed');
    expect(completed.finalText).toBe('Draft staged.');
    expect(completed.reason).toBe('end_turn');

    // Proposal landed in pending
    const all = await proposals.list({ tenantId: TENANT });
    expect(all).toHaveLength(1);
    const p = all[0]!;
    expect(p.status).toBe('pending');
    expect(p.actionType).toBe('draft_email_reply');
    expect(p.confidence).toBe(0.85);

    // Audit recorded both intent and outcome for the tool call
    const intents = await audit.listIntents(TENANT);
    const outcomes = await audit.listOutcomes(TENANT);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.actorType).toBe('agent');
    expect(intents[0]!.actorId).toBe(AGENT_ID);
    expect(intents[0]!.action).toBe('tool:create_proposal');
    expect(intents[0]!.toolName).toBe('create_proposal');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('executed');
    expect(outcomes[0]!.intentId).toBe(intents[0]!.id);
  });

  it('reviewer approves the staged proposal and the executor delivers via outbox', async () => {
    // 1. Agent stages
    await runAgent([
      {
        tools: [
          {
            name: 'create_proposal',
            input: {
              action_type: 'draft_email_reply',
              payload: {
                to: 'customer@example.com',
                subject: 'Re: refund',
                body: 'Working on it.',
              },
            },
          },
        ],
      },
      { text: 'done.' },
    ]);
    const [staged] = await proposals.list({ tenantId: TENANT, status: 'pending' });
    expect(staged).toBeDefined();

    // 2. Reviewer approves
    await proposals.decide(staged!.id, {
      approverId: 'reviewer-1',
      verdict: 'approved',
      decidedAt: new Date().toISOString(),
    });

    // 3. Executor runs (real MockEmailExecutor + real audit + real outbox)
    const registry = new ExecutorRegistry();
    registry.register(new MockEmailExecutor(outboxPath));
    const result = await executeProposal(
      staged!.id,
      { proposals, audit, registry },
      { expectTenantId: TENANT },
    );

    expect(result.status).toBe('executed');
    const final = await proposals.get(staged!.id);
    expect(final?.status).toBe('executed');

    // Outbox got the delivery
    const outboxRaw = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(outboxRaw.deliveries).toHaveLength(1);
    expect(outboxRaw.deliveries[0].channel).toBe('email');
    expect(outboxRaw.deliveries[0].proposalId).toBe(staged!.id);
    expect(outboxRaw.deliveries[0].payload).toEqual({
      to: 'customer@example.com',
      subject: 'Re: refund',
      body: 'Working on it.',
    });

    // Full audit trail: agent's tool intent+outcome, then system's execute intent+outcome
    const trail = await audit.listAuditTrail({ tenantId: TENANT });
    expect(trail).toHaveLength(2);
    const actions = trail.map((t) => t.intent.action).sort();
    expect(actions).toEqual([
      'execute_proposal:draft_email_reply',
      'tool:create_proposal',
    ]);
    for (const t of trail) {
      expect(t.outcome?.status).toBe('executed');
    }

    // Double-execute regression: a second execute call must not produce a
    // second outbox delivery or rewrite history. Both serial retries and
    // concurrent retries from a dropped client response are covered.
    const second = await executeProposal(
      staged!.id,
      { proposals, audit, registry },
      { expectTenantId: TENANT },
    );
    expect(second.status).toBe('skipped');
    const outboxAfter = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(outboxAfter.deliveries).toHaveLength(1); // unchanged

    const [a, b, c] = await Promise.all([
      executeProposal(staged!.id, { proposals, audit, registry }),
      executeProposal(staged!.id, { proposals, audit, registry }),
      executeProposal(staged!.id, { proposals, audit, registry }),
    ]);
    expect([a.status, b.status, c.status].sort()).toEqual([
      'skipped',
      'skipped',
      'skipped',
    ]);
    const outboxFinal = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(outboxFinal.deliveries).toHaveLength(1);
  });

  it('reviewer edits payload before approval; executor delivers the EDITED version', async () => {
    await runAgent([
      {
        tools: [
          {
            name: 'create_proposal',
            input: {
              action_type: 'draft_email_reply',
              payload: {
                to: 'customer@example.com',
                subject: 'Re: refund',
                body: 'TYPO original',
              },
            },
          },
        ],
      },
      { text: 'staged' },
    ]);
    const [staged] = await proposals.list({ tenantId: TENANT, status: 'pending' });

    const edited = {
      to: 'customer@example.com',
      subject: 'Re: refund',
      body: 'Corrected body — apologies for the delay.',
    };
    await proposals.decide(staged!.id, {
      approverId: 'reviewer-1',
      verdict: 'edited',
      editedPayload: edited,
      decidedAt: new Date().toISOString(),
    });

    const registry = new ExecutorRegistry();
    registry.register(new MockEmailExecutor(outboxPath));
    await executeProposal(staged!.id, { proposals, audit, registry });

    const outboxRaw = JSON.parse(await readFile(outboxPath, 'utf8'));
    expect(outboxRaw.deliveries[0].payload).toEqual(edited);
    // Original payload preserved on the proposal — not overwritten by edit
    const final = await proposals.get(staged!.id);
    expect(final?.payload).toEqual({
      to: 'customer@example.com',
      subject: 'Re: refund',
      body: 'TYPO original',
    });
    expect(final?.decision?.editedPayload).toEqual(edited);

    // Audit hash invariant: the execute_proposal intent must record the EDITED
    // payload (not the original draft) and the payloadHash must match the
    // hash of the edited payload. This is the tamper-evidence guarantee.
    const intents = await audit.listIntents(TENANT);
    const executeIntent = intents.find(
      (i) => i.action === 'execute_proposal:draft_email_reply',
    );
    expect(executeIntent).toBeDefined();
    expect(executeIntent!.payload).toEqual(edited);
    expect(executeIntent!.payloadHash).toBe(hashPayload(edited));
    expect(executeIntent!.payloadHash).not.toBe(
      hashPayload({
        to: 'customer@example.com',
        subject: 'Re: refund',
        body: 'TYPO original',
      }),
    );
  });

  it('dispatches multiple tool_use blocks in a single turn in order', async () => {
    const baseCalls: Array<{ name: string; input: unknown }> = [];
    const baseExecutor: ToolExecutor = async (name, input) => {
      baseCalls.push({ name, input });
      return { ok: true, who: name };
    };
    const composed = auditedExecutor(
      withProposalTool(baseExecutor, {
        proposals,
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      { audit, tenantId: TENANT, runId: RUN_ID, agentId: AGENT_ID },
    );
    const runtime = new FakeAgentRuntime({
      turns: [
        {
          tools: [
            { name: 'search_documents', input: { q: 'first' } },
            { name: 'search_documents', input: { q: 'second' } },
          ],
        },
        { text: 'done' },
      ],
    });
    const events = await collect(
      runtime.run({
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'test',
        userMessage: 'go',
        tools: [CREATE_PROPOSAL_TOOL],
        toolExecutor: composed,
        maxSteps: 5,
        maxTokens: 1000,
      }),
    );

    // Both tools dispatched, in order, with matching ids
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolCalls).toHaveLength(2);
    expect(toolResults).toHaveLength(2);
    expect(baseCalls.map((c) => c.input)).toEqual([{ q: 'first' }, { q: 'second' }]);
    for (let i = 0; i < 2; i++) {
      const call = toolCalls[i]!;
      const result = toolResults[i]!;
      if (call.type !== 'tool_call' || result.type !== 'tool_result') {
        throw new Error('wrong event shape');
      }
      expect(call.id).toBe(result.id);
      expect(result.isError).toBe(false);
    }

    // Audit records intent+outcome for BOTH calls
    const intents = await audit.listIntents(TENANT);
    expect(intents).toHaveLength(2);
    const outcomes = await audit.listOutcomes(TENANT);
    expect(outcomes).toHaveLength(2);
    for (const o of outcomes) expect(o.status).toBe('executed');
  });

  it('tool that throws emits tool_result.isError and records audit outcome=failed', async () => {
    const baseExecutor: ToolExecutor = async () => {
      throw new Error('upstream timeout');
    };
    const composed = auditedExecutor(
      withProposalTool(baseExecutor, {
        proposals,
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      { audit, tenantId: TENANT, runId: RUN_ID, agentId: AGENT_ID },
    );
    const runtime = new FakeAgentRuntime({
      turns: [
        { tools: [{ name: 'search_documents', input: { q: 'x' } }] },
        { text: 'gave up' },
      ],
    });
    const events = await collect(
      runtime.run({
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'test',
        userMessage: 'go',
        tools: [CREATE_PROPOSAL_TOOL],
        toolExecutor: composed,
        maxSteps: 5,
        maxTokens: 1000,
      }),
    );
    const toolResult = events.find((e) => e.type === 'tool_result');
    if (toolResult?.type !== 'tool_result') throw new Error('missing');
    expect(toolResult.isError).toBe(true);
    expect((toolResult.result as { error: string }).error).toMatch(/upstream timeout/);

    const intents = await audit.listIntents(TENANT);
    const outcomes = await audit.listOutcomes(TENANT);
    expect(intents).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.errorText).toMatch(/upstream timeout/);
  });

  it('agent that emits text-only (no tool_use) ends without creating a proposal', async () => {
    const events = await runAgent([
      { text: 'I could not find the source message; please provide more detail.' },
    ]);
    const completed = events.find((e) => e.type === 'completed');
    expect(completed?.type).toBe('completed');
    const all = await proposals.list({ tenantId: TENANT });
    expect(all).toHaveLength(0);
    const intents = await audit.listIntents(TENANT);
    expect(intents).toHaveLength(0);
  });

  it('cost ceiling halts the run before exceeding budget', async () => {
    const baseExecutor: ToolExecutor = async () => ({});
    const composed = auditedExecutor(
      withProposalTool(baseExecutor, {
        proposals,
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      { audit, tenantId: TENANT, runId: RUN_ID, agentId: AGENT_ID },
    );
    const runtime = new FakeAgentRuntime({
      turns: [
        {
          tools: [
            {
              name: 'create_proposal',
              input: {
                action_type: 'draft_email_reply',
                payload: { to: 'x@y.com', subject: 's', body: 'b' },
              },
            },
          ],
          costMicros: 5000,
        },
        { text: 'should not reach here', costMicros: 5000 },
      ],
    });
    const events = await collect(
      runtime.run({
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'test',
        userMessage: 'go',
        tools: [CREATE_PROPOSAL_TOOL],
        toolExecutor: composed,
        maxSteps: 5,
        maxTokens: 1000,
        costCeilingMicros: 3000,
      }),
    );
    // The first turn cost 5000, exceeding the 3000 ceiling. The check fires
    // on the *next* step, so the run halts after the first assistant turn.
    const halted = events.find((e) => e.type === 'halted');
    expect(halted?.type).toBe('halted');
    if (halted?.type === 'halted') {
      expect(halted.reason).toMatch(/cost_ceiling_reached/);
    }
    // The first proposal still landed (the side effect is already done by the
    // time the ceiling check runs — same semantics as AnthropicRuntime).
    const all = await proposals.list({ tenantId: TENANT });
    expect(all).toHaveLength(1);
  });

  it('killSwitchCheck halts the run immediately on next step', async () => {
    const baseExecutor: ToolExecutor = async () => ({});
    const composed = auditedExecutor(
      withProposalTool(baseExecutor, {
        proposals,
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
      }),
      { audit, tenantId: TENANT, runId: RUN_ID, agentId: AGENT_ID },
    );
    let calls = 0;
    const runtime = new FakeAgentRuntime({
      turns: [
        { text: 'should never run' },
      ],
    });
    const events = await collect(
      runtime.run({
        tenantId: TENANT,
        runId: RUN_ID,
        agentId: AGENT_ID,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'test',
        userMessage: 'go',
        tools: [CREATE_PROPOSAL_TOOL],
        toolExecutor: composed,
        maxSteps: 5,
        maxTokens: 1000,
        killSwitchCheck: async () => {
          calls++;
          return true;
        },
      }),
    );
    expect(calls).toBe(1);
    const halted = events.find((e) => e.type === 'halted');
    expect(halted?.type).toBe('halted');
    if (halted?.type === 'halted') {
      expect(halted.reason).toBe('kill_switch_tripped');
    }
  });
});

async function collect(stream: AsyncIterable<RunStepEvent>): Promise<RunStepEvent[]> {
  const out: RunStepEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}
