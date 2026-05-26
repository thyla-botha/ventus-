import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileAuditStore,
  FileProposalStore,
  FileRunStore,
  FileTenantProfileStore,
} from '@ventus/store';
import type { Skill } from '@ventus/skills';
import { FakeAgentRuntime } from './fake-runtime.js';
import { runAgent, startRunAgent } from './run-agent.js';
import type { AgentRuntime, RunInput, RunStepEvent } from './runtime.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const AGENT_ID = 'cli:test';

function tier2Skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'customer-reply-drafter',
    description: 'test skill',
    tier: 2,
    allowedTools: ['create_proposal'],
    model: 'claude-sonnet-4-6',
    maxSteps: 5,
    maxTokens: 1000,
    costCeilingCents: null,
    policy: null,
    systemPrompt: 'test agent',
    path: '/tmp/test-skill/SKILL.md',
    // 64-char hex stand-in. Real values come from sha256(SKILL.md bytes).
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

// Runtime that throws mid-stream — models the "Anthropic SDK threw before
// emitting an error event" case the lifecycle invariant must survive.
class ThrowingRuntime implements AgentRuntime {
  readonly provider = 'fake';
  constructor(private readonly thrownErr: Error) {}
  async *run(_input: RunInput): AsyncIterable<RunStepEvent> {
    yield { type: 'step_started', stepNo: 1 };
    throw this.thrownErr;
  }
}

describe('runAgent', () => {
  let dir: string;
  let proposals: FileProposalStore;
  let audit: FileAuditStore;
  let runs: FileRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-runagent-'));
    proposals = new FileProposalStore(join(dir, 'proposals.json'));
    audit = new FileAuditStore(join(dir, 'audit.json'));
    runs = new FileRunStore(join(dir, 'runs.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens and closes a Run row around a normal completion', async () => {
    const runtime = new FakeAgentRuntime({
      turns: [
        {
          tools: [
            {
              name: 'create_proposal',
              input: {
                action_type: 'draft_email_reply',
                payload: { to: 'a@b.com', subject: 's', body: 'b' },
              },
            },
          ],
        },
        { text: 'Done.' },
      ],
    });

    const result = await runAgent(
      { proposals, audit, runs, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );

    expect(result.status).toBe('completed');
    expect(result.proposalCount).toBe(1);

    const row = await runs.get(result.runId);
    expect(row?.status).toBe('completed');
    expect(row?.endedAt).toBeDefined();
    expect(row?.skillId).toBe('customer-reply-drafter');
    expect(row?.tenantId).toBe(TENANT);
  });

  it('closes the Run as failed when the runtime throws mid-stream', async () => {
    // Critical lifecycle invariant (codex caught the original bug): a thrown
    // iteration must NEVER leave a Run stuck in 'running'. The runtime error
    // is reflected as status='failed' on the resolved result + the Run row,
    // not as a rejected promise — the API path runs this in the background
    // and unhandled rejections would be a footgun.
    const runtime = new ThrowingRuntime(new Error('anthropic 500'));
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill(),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
      },
    );

    expect(result.status).toBe('failed');
    const row = await runs.get(result.runId);
    expect(row?.status).toBe('failed');
    expect(row?.endedAt).toBeDefined();
    expect(row?.errorText).toMatch(/anthropic 500/);
  });

  it('startRunAgent returns the run row immediately and completes in the background', async () => {
    const runtime = new FakeAgentRuntime({
      turns: [{ text: 'done.' }],
    });
    const handle = await startRunAgent(
      { proposals, audit, runs, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    // Row is open and visible BEFORE completion resolves — this is the
    // property the API depends on (return runId, drive loop async).
    expect(handle.run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(handle.run.status).toBe('running');
    const fetched = await runs.get(handle.run.id);
    expect(fetched?.status).toBe('running');

    const result = await handle.completion;
    expect(result.runId).toBe(handle.run.id);
    expect(result.status).toBe('completed');
    const closed = await runs.get(handle.run.id);
    expect(closed?.status).toBe('completed');
  });

  it('returns the list of unknown tools (skill allows tool not wired locally)', async () => {
    const runtime = new FakeAgentRuntime({ turns: [{ text: 'nothing to do.' }] });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill({
          allowedTools: ['create_proposal', 'send_email_directly', 'frobnicate'],
        }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
      },
    );
    expect(result.unknownTools.sort()).toEqual(['frobnicate', 'send_email_directly']);
  });

  it('streams every RunStepEvent through onEvent in order', async () => {
    const events: string[] = [];
    const runtime = new FakeAgentRuntime({
      turns: [{ text: 'hello.' }],
    });
    await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill(),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
        onEvent: (e) => events.push(e.type),
      },
    );
    expect(events).toEqual(['step_started', 'assistant_message', 'completed']);
  });

  it('does not let onEvent exceptions disrupt the run', async () => {
    // A misbehaving caller should never destabilise the lifecycle.
    const runtime = new FakeAgentRuntime({
      turns: [{ text: 'done.' }],
    });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill(),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
        onEvent: () => {
          throw new Error('callback bug');
        },
      },
    );
    expect(result.status).toBe('completed');
    const row = await runs.get(result.runId);
    expect(row?.status).toBe('completed');
  });

  it('user cancellation closes the run as aborted (not halted)', async () => {
    // The runtime emits 'halted' for both cost-ceiling AND kill-switch trips.
    // runAgent disambiguates: if its killSwitchCheck closure observed
    // cancelRequestedAt on the store row, the close is rewritten to
    // status='aborted'. Without this mapping, a user-clicked Cancel would
    // be indistinguishable from a guardrail halt on the Run row + UI.
    //
    // We need a script that doesn't terminate before step 2 so the cancel
    // marker (set after startRunAgent returns) has time to take effect. A
    // tool turn keeps the loop alive; the kill switch fires at the top of
    // step 2 because by then requestCancel has flipped the row.
    const runtime = new FakeAgentRuntime({
      turns: [
        // step 1: tool turn; doesn't end the loop
        { tools: [{ name: 'search_documents', input: { query: 'x' } }] },
        // step 2 would consume this — but kill switch trips first
        { text: 'never reached' },
      ],
    });

    const handle = await startRunAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill({ allowedTools: ['search_documents'] }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'go',
      },
    );
    await runs.requestCancel(handle.run.id, { requestedBy: 'tester' });
    const result = await handle.completion;

    expect(result.status).toBe('aborted');
    const row = await runs.get(handle.run.id);
    expect(row?.status).toBe('aborted');
    expect(row?.haltReason).toBe('kill_switch_tripped');
    expect(row?.cancelRequestedBy).toBe('tester');
  });

  it('cancellation on a row with no pre-cancel polls cleanly resolves running runs', async () => {
    // Sanity check: if the user never cancels, the kill-switch path stays
    // dormant and the run completes normally (status='completed'). Guards
    // against accidentally treating a benign killSwitchCheck return value
    // as a cancel signal.
    const runtime = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    const row = await runs.get(result.runId);
    expect(row?.cancelRequestedAt).toBeUndefined();
  });

  it('pins skillContentHash + contextSnapshotHash on the Run row', async () => {
    // Provenance invariant: the row must carry the exact skill bytes hash
    // PLUS a context snapshot hash that mixes in model, tool list, caps, and
    // the user message hash. Lets an auditor verify months later: "this row
    // ran against THIS skill version with THIS effective context."
    const runtime = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const row = await runs.get(result.runId);
    expect(row?.skillContentHash).toBe('a'.repeat(64));
    expect(row?.contextSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('contextSnapshotHash is deterministic for identical inputs', async () => {
    // Reproducibility check: two runs of the same skill + same message must
    // produce the same snapshot hash, even though runIds differ. This is
    // what makes the hash useful for comparison ("did anything change?").
    const runtime1 = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const runtime2 = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const r1 = await runAgent(
      { proposals, audit, runs, runtime: runtime1 },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const r2 = await runAgent(
      { proposals, audit, runs, runtime: runtime2 },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const row1 = await runs.get(r1.runId);
    const row2 = await runs.get(r2.runId);
    expect(row1?.contextSnapshotHash).toBe(row2?.contextSnapshotHash);
  });

  it('contextSnapshotHash differs when user message changes', async () => {
    // Sensitivity check: the hash must change if the user message changes,
    // because the message is part of the effective per-run context.
    const r1 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'a.' }] }) },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'one' },
    );
    const r2 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'b.' }] }) },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'two' },
    );
    const row1 = await runs.get(r1.runId);
    const row2 = await runs.get(r2.runId);
    expect(row1?.contextSnapshotHash).not.toBe(row2?.contextSnapshotHash);
  });

  it('contextSnapshotHash differs when skill bytes change', async () => {
    // The skill hash is part of the snapshot — editing the SKILL.md must
    // surface as a different snapshot even with the same model + message.
    const r1 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'a.' }] }) },
      {
        skill: tier2Skill({ contentHash: 'a'.repeat(64) }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
      },
    );
    const r2 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'b.' }] }) },
      {
        skill: tier2Skill({ contentHash: 'b'.repeat(64) }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
      },
    );
    const row1 = await runs.get(r1.runId);
    const row2 = await runs.get(r2.runId);
    expect(row1?.contextSnapshotHash).not.toBe(row2?.contextSnapshotHash);
  });

  it('propagates contextSnapshotHash to proposals and audit intents', async () => {
    // Provenance lineage: every proposal and intent born of this run must
    // carry the run's snapshot hash so an auditor can verify a proposal
    // independently of the (mutable-in-future-DB) Run row.
    const runtime = new FakeAgentRuntime({
      turns: [
        {
          tools: [
            {
              name: 'create_proposal',
              input: {
                action_type: 'draft_email_reply',
                payload: { to: 'a@b.com', subject: 's', body: 'b' },
              },
            },
          ],
        },
        { text: 'Done.' },
      ],
    });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const row = await runs.get(result.runId);
    const hash = row?.contextSnapshotHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const props = await proposals.list({ tenantId: TENANT, runId: result.runId });
    expect(props.length).toBe(1);
    expect(props[0]!.contextSnapshotHash).toBe(hash);

    const trail = await audit.listAuditTrail({ tenantId: TENANT, runId: result.runId });
    expect(trail.length).toBeGreaterThan(0);
    for (const row of trail) {
      expect(row.intent.contextSnapshotHash).toBe(hash);
    }
  });

  it('injects tenant profile body at top of system prompt when present', async () => {
    // The whole point of the tenant_profile feature: a profile body, if set,
    // shows up at the top of the effective system prompt the runtime sees.
    // We capture input.systemPrompt via an inline runtime to confirm the
    // composition shape — <tenant_context>{body}</tenant_context> followed
    // by the skill's own body — without coupling the test to any specific
    // delimiter wording beyond "block-then-skill".
    const tenantProfiles = new FileTenantProfileStore(join(dir, 'tenant-profiles.json'));
    await tenantProfiles.set(
      TENANT,
      'Brand voice: warm.\nIndustry: real estate.',
      { updatedBy: 'admin' },
    );

    let observedPrompt: string | undefined;
    const runtime: AgentRuntime = {
      provider: 'fake',
      async *run(input: RunInput): AsyncIterable<RunStepEvent> {
        observedPrompt = input.systemPrompt;
        yield { type: 'step_started', stepNo: 1 };
        yield {
          type: 'assistant_message',
          content: [],
          stopReason: 'end_turn',
          costMicros: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        yield { type: 'completed', totalCostMicros: 0, finalText: 'ok', reason: 'end_turn' };
      },
    };

    await runAgent(
      { proposals, audit, runs, runtime, tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );

    expect(observedPrompt).toContain('<tenant_context>');
    expect(observedPrompt).toContain('Brand voice: warm.');
    expect(observedPrompt).toContain('Industry: real estate.');
    expect(observedPrompt).toContain('</tenant_context>');
    // Skill body must come AFTER the tenant block — the model should read
    // the skill's instructions last so they take precedence.
    const ctxEnd = observedPrompt!.indexOf('</tenant_context>');
    const skillIdx = observedPrompt!.indexOf('test agent');
    expect(skillIdx).toBeGreaterThan(ctxEnd);
  });

  it('leaves system prompt unchanged when tenant has no profile', async () => {
    // Absent profile is a first-class case: the prompt is EXACTLY the
    // skill's body. No empty <tenant_context> block leaks through.
    const tenantProfiles = new FileTenantProfileStore(join(dir, 'tenant-profiles.json'));
    // Deliberately do NOT call set() — tenant has no profile.

    let observedPrompt: string | undefined;
    const runtime: AgentRuntime = {
      provider: 'fake',
      async *run(input: RunInput): AsyncIterable<RunStepEvent> {
        observedPrompt = input.systemPrompt;
        yield { type: 'step_started', stepNo: 1 };
        yield {
          type: 'assistant_message',
          content: [],
          stopReason: 'end_turn',
          costMicros: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        yield { type: 'completed', totalCostMicros: 0, finalText: 'ok', reason: 'end_turn' };
      },
    };

    await runAgent(
      { proposals, audit, runs, runtime, tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );

    expect(observedPrompt).toBe('test agent');
    expect(observedPrompt).not.toContain('tenant_context');
  });

  it('pins tenantProfileHash on the Run row (set when present, null when absent)', async () => {
    // Provenance: an auditor looking at the row months later must be able
    // to say "this run saw profile snapshot X" — even if the live profile
    // has been edited since. We assert the hash matches the store's hash
    // when present, and is null when absent.
    const tenantProfiles = new FileTenantProfileStore(join(dir, 'tenant-profiles.json'));
    const written = await tenantProfiles.set(
      TENANT,
      'Brand voice: warm.',
      { updatedBy: 'admin' },
    );

    const runtimeWithProfile = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const withProfile = await runAgent(
      { proposals, audit, runs, runtime: runtimeWithProfile, tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const rowWith = await runs.get(withProfile.runId);
    expect(rowWith?.tenantProfileHash).toBe(written.contentHash);

    // Different tenant id → no profile → null hash.
    const OTHER_TENANT = '00000000-0000-0000-0000-00000000000b';
    const runtimeNoProfile = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const without = await runAgent(
      { proposals, audit, runs, runtime: runtimeNoProfile, tenantProfiles },
      { skill: tier2Skill(), tenantId: OTHER_TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const rowWithout = await runs.get(without.runId);
    expect(rowWithout?.tenantProfileHash).toBeNull();
  });

  it('contextSnapshotHash differs when tenant profile changes', async () => {
    // Sensitivity check: editing the profile body must invalidate the
    // snapshot hash for subsequent runs — the agent saw different bytes.
    const tenantProfiles = new FileTenantProfileStore(join(dir, 'tenant-profiles.json'));
    await tenantProfiles.set(TENANT, 'first version', { updatedBy: 'admin' });
    const r1 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'a.' }] }), tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    await tenantProfiles.set(TENANT, 'second version', { updatedBy: 'admin' });
    const r2 = await runAgent(
      { proposals, audit, runs, runtime: new FakeAgentRuntime({ turns: [{ text: 'b.' }] }), tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    const row1 = await runs.get(r1.runId);
    const row2 = await runs.get(r2.runId);
    expect(row1?.contextSnapshotHash).not.toBe(row2?.contextSnapshotHash);
    expect(row1?.tenantProfileHash).not.toBe(row2?.tenantProfileHash);
  });

  it('omitting tenantProfiles dep behaves identically to "no profile" (backwards compat)', async () => {
    // The CLI and existing tests don't wire tenantProfiles. They must keep
    // producing snapshot hashes identical to "store wired, tenant has no
    // profile" runs — otherwise pre-existing rows would silently re-classify.
    const runtime1 = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const noDep = await runAgent(
      { proposals, audit, runs, runtime: runtime1 },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );

    const tenantProfiles = new FileTenantProfileStore(join(dir, 'tenant-profiles.json'));
    const runtime2 = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const withDepNoProfile = await runAgent(
      { proposals, audit, runs, runtime: runtime2, tenantProfiles },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );

    const row1 = await runs.get(noDep.runId);
    const row2 = await runs.get(withDepNoProfile.runId);
    expect(row1?.contextSnapshotHash).toBe(row2?.contextSnapshotHash);
    expect(row1?.tenantProfileHash).toBeNull();
    expect(row2?.tenantProfileHash).toBeNull();
  });

  it('writes a heartbeat for every step_started event the runtime emits', async () => {
    // Reaper contract: a 'running' row whose lastHeartbeatAt is stale gets
    // closed as failed. For that to work, the loop has to actually write
    // heartbeats. We script a multi-step run and assert lastHeartbeatAt is
    // populated by the time the loop ends. Fire-and-forget — we await the
    // microtask queue after completion so the trailing heartbeat lands.
    const runtime = new FakeAgentRuntime({
      turns: [
        { tools: [{ name: 'search_documents', input: { query: 'x' } }] },
        { tools: [{ name: 'search_documents', input: { query: 'y' } }] },
        { text: 'done.' },
      ],
    });
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill({ allowedTools: ['search_documents'] }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
      },
    );
    // Fire-and-forget heartbeats may still be settling — let the
    // microtask + writeLock chain drain before reading the row.
    await new Promise((r) => setTimeout(r, 20));
    const row = await runs.get(result.runId);
    expect(row?.lastHeartbeatAt).toBeDefined();
    expect(new Date(row!.lastHeartbeatAt!).toISOString()).toBe(row!.lastHeartbeatAt);
  });

  it('does not crash when the heartbeat store write fails', async () => {
    // Best-effort contract: a transient store failure during heartbeat MUST
    // NOT take down a healthy loop. We swap in a runs facade whose
    // heartbeat() always throws and confirm the run still completes cleanly.
    const realRuns = runs;
    const flakyRuns = new Proxy(realRuns, {
      get(target, prop, receiver) {
        if (prop === 'heartbeat') {
          return async () => {
            throw new Error('store unavailable');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const runtime = new FakeAgentRuntime({ turns: [{ text: 'done.' }] });
    const result = await runAgent(
      { proposals, audit, runs: flakyRuns, runtime },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    expect(result.status).toBe('completed');
  });

  it('adopts the reaper close when complete() races against an already-closed row', async () => {
    // Race: reaper closes the row as failed/no-heartbeat while the loop is
    // still emitting events. The loop's own complete() at the end will throw
    // "not running". Without race handling, that throw would reject the
    // completion Promise and trackInflight in the API would log a spurious
    // error. The contract is: reaper's verdict wins, loop adopts it
    // gracefully.
    const realRuns = runs;
    const handle = await startRunAgent(
      { proposals, audit, runs: realRuns, runtime: new FakeAgentRuntime({ turns: [{ text: 'done.' }] }) },
      { skill: tier2Skill(), tenantId: TENANT, agentId: AGENT_ID, userMessage: 'help' },
    );
    // Simulate the reaper closing the row out from under the loop BEFORE
    // its own complete() lands. The fake runtime's loop is already running
    // and will reach the complete() call; we close the row first.
    await realRuns.complete(handle.run.id, {
      status: 'failed',
      errorText: 'no heartbeat',
      haltReason: 'reaper_stale_heartbeat',
    });
    const result = await handle.completion;
    // Reaper's verdict is what the row reports; the loop adopts it without
    // throwing or polluting trackInflight with a rejection.
    expect(result.status).toBe('failed');
    const row = await realRuns.get(result.runId);
    expect(row?.errorText).toBe('no heartbeat');
    expect(row?.haltReason).toBe('reaper_stale_heartbeat');
  });

  it('applies modelOverride to the Run row and the runtime call', async () => {
    let observedModel: string | undefined;
    const runtime: AgentRuntime = {
      provider: 'fake',
      async *run(input: RunInput): AsyncIterable<RunStepEvent> {
        observedModel = input.model;
        yield { type: 'step_started', stepNo: 1 };
        yield {
          type: 'assistant_message',
          content: [],
          stopReason: 'end_turn',
          costMicros: 0,
          tokensIn: 0,
          tokensOut: 0,
        };
        yield { type: 'completed', totalCostMicros: 0, finalText: 'ok', reason: 'end_turn' };
      },
    };
    const result = await runAgent(
      { proposals, audit, runs, runtime },
      {
        skill: tier2Skill({ model: 'claude-sonnet-4-6' }),
        tenantId: TENANT,
        agentId: AGENT_ID,
        userMessage: 'help',
        modelOverride: 'claude-haiku-4-5-20251001',
      },
    );
    expect(observedModel).toBe('claude-haiku-4-5-20251001');
    const row = await runs.get(result.runId);
    expect(row?.model).toBe('claude-haiku-4-5-20251001');
  });
});
