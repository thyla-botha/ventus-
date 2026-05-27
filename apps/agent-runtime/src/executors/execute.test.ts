import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuditStore, FileProposalStore, type Proposal } from '@ventus/store';
import { ExecutorRegistry, type ProposalExecutor, type ExecutorContext } from './types.js';
import { executeProposal, executeAllApproved } from './execute.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

interface RecordingExecutor extends ProposalExecutor {
  calls: Array<{ proposal: Proposal; ctx: ExecutorContext }>;
}

function recorder(actionType: string, result: unknown = { ok: true }): RecordingExecutor {
  const calls: RecordingExecutor['calls'] = [];
  return {
    actionType,
    calls,
    async execute(proposal, ctx) {
      calls.push({ proposal, ctx });
      return result;
    },
  };
}

function thrower(actionType: string, message: string): ProposalExecutor {
  return {
    actionType,
    async execute() {
      throw new Error(message);
    },
  };
}

async function makeApproved(
  proposals: FileProposalStore,
  overrides: Partial<Pick<Proposal, 'actionType' | 'payload'>> = {},
): Promise<Proposal> {
  const created = await proposals.create({
    tenantId: TENANT,
    runId: 'run-1',
    agentId: 'agent-1',
    actionType: overrides.actionType ?? 'draft_email_reply',
    payload: overrides.payload ?? { to: 'a@b.com', subject: 's', body: 'b' },
  });
  return proposals.decide(created.id, {
    approverId: 'user-1',
    verdict: 'approved',
    decidedAt: new Date().toISOString(),
  });
}

describe('executeProposal', () => {
  let dir: string;
  let proposals: FileProposalStore;
  let audit: FileAuditStore;
  let registry: ExecutorRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-execute-'));
    proposals = new FileProposalStore(join(dir, 'proposals.json'));
    audit = new FileAuditStore(join(dir, 'audit.json'));
    registry = new ExecutorRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('executes an approved proposal, writes intent+outcome, flips to executed', async () => {
    const exec = recorder('draft_email_reply', { delivery_id: 'd1' });
    registry.register(exec);
    const proposal = await makeApproved(proposals);

    const result = await executeProposal(proposal.id, { proposals, audit, registry });

    expect(result.status).toBe('executed');
    expect(result.result).toEqual({ delivery_id: 'd1' });

    const after = await proposals.get(proposal.id);
    expect(after?.status).toBe('executed');

    const intents = await audit.listIntents(TENANT);
    const outcomes = await audit.listOutcomes(TENANT);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.actorType).toBe('system');
    expect(intents[0]!.action).toBe('execute_proposal:draft_email_reply');
    expect(intents[0]!.resourceType).toBe('proposal');
    expect(intents[0]!.resourceId).toBe(proposal.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('executed');
    expect(outcomes[0]!.intentId).toBe(intents[0]!.id);
  });

  it('passes approverId from decision into executor context', async () => {
    const exec = recorder('draft_email_reply');
    registry.register(exec);
    const proposal = await makeApproved(proposals);

    await executeProposal(proposal.id, { proposals, audit, registry });
    expect(exec.calls[0]!.ctx.approverId).toBe('user-1');
    expect(exec.calls[0]!.ctx.tenantId).toBe(TENANT);
    expect(exec.calls[0]!.ctx.proposalId).toBe(proposal.id);
  });

  it('passes idempotencyKey=proposal.id into executor context (at-most-once contract)', async () => {
    // The orchestrator MUST supply a stable idempotency key. Today it's
    // proposal.id; if that ever changes, downstream side effects that dedupe
    // on the key will silently start duplicating. Pin the contract here.
    const exec = recorder('draft_email_reply');
    registry.register(exec);
    const proposal = await makeApproved(proposals);
    await executeProposal(proposal.id, { proposals, audit, registry });
    expect(exec.calls[0]!.ctx.idempotencyKey).toBe(proposal.id);
  });

  it('skips when proposal is missing', async () => {
    const result = await executeProposal('not-a-real-id', { proposals, audit, registry });
    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/not found/);

    // No audit rows written for skip.
    expect(await audit.listIntents(TENANT)).toHaveLength(0);
  });

  it('skips when proposal is not approved (still pending)', async () => {
    const created = await proposals.create({
      tenantId: TENANT,
      runId: 'run-1',
      agentId: 'agent-1',
      actionType: 'draft_email_reply',
      payload: { to: 'a@b.com', subject: 's', body: 'b' },
    });
    const result = await executeProposal(created.id, { proposals, audit, registry });
    expect(result.status).toBe('skipped');
    expect(result.error).toMatch(/not approved/);
    expect(await audit.listIntents(TENANT)).toHaveLength(0);
  });

  it('fails (audited) when no executor is registered for action_type', async () => {
    const proposal = await makeApproved(proposals, { actionType: 'unknown_action' });

    const result = await executeProposal(proposal.id, { proposals, audit, registry });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no executor registered/);

    // Proposal moves to 'failed' — the claim was consumed and the executor
    // gap is now a terminal failure surfaced for ops.
    const after = await proposals.get(proposal.id);
    expect(after?.status).toBe('failed');

    const outcomes = await audit.listOutcomes(TENANT);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.errorText).toMatch(/no executor registered/);
  });

  it('records failed outcome AND flips proposal to failed when executor throws', async () => {
    registry.register(thrower('draft_email_reply', 'SMTP down'));
    const proposal = await makeApproved(proposals);

    const result = await executeProposal(proposal.id, { proposals, audit, registry });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('SMTP down');

    const after = await proposals.get(proposal.id);
    expect(after?.status).toBe('failed');

    const outcomes = await audit.listOutcomes(TENANT);
    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.errorText).toBe('SMTP down');
  });

  it('claims atomically — concurrent execute calls run the side effect at most once', async () => {
    let calls = 0;
    registry.register({
      actionType: 'draft_email_reply',
      async execute() {
        calls += 1;
        // Small async tick so the parallel call has a chance to race.
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      },
    });
    const proposal = await makeApproved(proposals);

    const deps = { proposals, audit, registry };
    const [a, b, c] = await Promise.all([
      executeProposal(proposal.id, deps),
      executeProposal(proposal.id, deps),
      executeProposal(proposal.id, deps),
    ]);

    const executed = [a, b, c].filter((r) => r.status === 'executed');
    const skipped = [a, b, c].filter((r) => r.status === 'skipped');
    expect(executed).toHaveLength(1);
    expect(skipped).toHaveLength(2);
    expect(calls).toBe(1);

    const after = await proposals.get(proposal.id);
    expect(after?.status).toBe('executed');
  });

  it('uses effectivePayload (editedPayload) for the audit intent hash, not the original draft', async () => {
    registry.register(recorder('draft_email_reply'));
    const created = await proposals.create({
      tenantId: TENANT,
      runId: 'run-1',
      agentId: 'agent-1',
      actionType: 'draft_email_reply',
      payload: { to: 'original@x.com', subject: 's', body: 'agent-draft' },
    });
    const editedPayload = { to: 'edited@x.com', subject: 's', body: 'reviewer-rewrote' };
    await proposals.decide(created.id, {
      approverId: 'user-1',
      verdict: 'edited',
      editedPayload,
      decidedAt: new Date().toISOString(),
    });

    await executeProposal(created.id, { proposals, audit, registry });

    const intents = await audit.listIntents(TENANT);
    const execIntent = intents.find((i) => i.action.startsWith('execute_proposal:'));
    expect(execIntent).toBeDefined();
    expect(execIntent!.payload).toEqual(editedPayload);
    // The hash describes the executed payload, not the draft.
    expect(execIntent!.payloadHash).toBeDefined();
  });

  it('returns executed (not failed) even if recordOutcome write fails after the executor succeeded', async () => {
    let deliveries = 0;
    registry.register({
      actionType: 'draft_email_reply',
      async execute() {
        deliveries += 1;
        return { ok: true };
      },
    });
    const proposal = await makeApproved(proposals);

    // First recordOutcome call succeeds (the intent's pair), second throws.
    let outcomeCalls = 0;
    const realRecord = audit.recordOutcome.bind(audit);
    const flaky = Object.create(audit) as typeof audit;
    Object.defineProperty(flaky, 'recordOutcome', {
      value: async (...args: Parameters<typeof realRecord>) => {
        outcomeCalls += 1;
        if (outcomeCalls === 1) throw new Error('audit unavailable');
        return realRecord(...args);
      },
    });

    const result = await executeProposal(proposal.id, { proposals, audit: flaky, registry });

    // Side effect ran; the post-execute audit write failed, but we MUST report
    // executed and the intent stays as an orphan for reconciliation.
    expect(deliveries).toBe(1);
    expect(result.status).toBe('executed');

    const trail = await audit.listAuditTrail({ tenantId: TENANT });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.outcome).toBeNull(); // orphan
  });

  it('refuses to execute when expectTenantId does not match (defense-in-depth)', async () => {
    const exec = recorder('draft_email_reply');
    registry.register(exec);
    const proposal = await makeApproved(proposals);

    const result = await executeProposal(
      proposal.id,
      { proposals, audit, registry },
      { expectTenantId: '00000000-0000-0000-0000-00000000000b' },
    );
    expect(result.status).toBe('skipped');
    expect(exec.calls).toHaveLength(0);
    const after = await proposals.get(proposal.id);
    // proposal stays approved — never claimed
    expect(after?.status).toBe('approved');
    // no audit intent written for the wrong-tenant call
    const intents = await audit.listIntents(TENANT);
    expect(intents).toHaveLength(0);
  });

  it('executes normally when expectTenantId matches', async () => {
    const exec = recorder('draft_email_reply');
    registry.register(exec);
    const proposal = await makeApproved(proposals);

    const result = await executeProposal(
      proposal.id,
      { proposals, audit, registry },
      { expectTenantId: TENANT },
    );
    expect(result.status).toBe('executed');
    expect(exec.calls).toHaveLength(1);
  });

  it('uses configurable systemActorId for the intent actorId', async () => {
    registry.register(recorder('draft_email_reply'));
    const proposal = await makeApproved(proposals);

    await executeProposal(proposal.id, {
      proposals,
      audit,
      registry,
      systemActorId: 'executor:cron',
    });
    const intents = await audit.listIntents(TENANT);
    expect(intents[0]!.actorId).toBe('executor:cron');
  });
});

describe('executeAllApproved', () => {
  let dir: string;
  let proposals: FileProposalStore;
  let audit: FileAuditStore;
  let registry: ExecutorRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-execute-all-'));
    proposals = new FileProposalStore(join(dir, 'proposals.json'));
    audit = new FileAuditStore(join(dir, 'audit.json'));
    registry = new ExecutorRegistry();
    registry.register(recorder('draft_email_reply'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('processes every approved proposal in the list', async () => {
    const a = await makeApproved(proposals);
    const b = await makeApproved(proposals);
    // a pending one should be ignored:
    await proposals.create({
      tenantId: TENANT,
      runId: 'run-1',
      agentId: 'agent-1',
      actionType: 'draft_email_reply',
      payload: { to: 'a@b.com', subject: 's', body: 'b' },
    });

    const results = await executeAllApproved({ proposals, audit, registry });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'executed')).toBe(true);

    const ids = new Set(results.map((r) => r.proposalId));
    expect(ids).toEqual(new Set([a.id, b.id]));
  });

  it('filters by tenantId', async () => {
    await makeApproved(proposals);
    // approved proposal in tenant B
    const otherTenant = '00000000-0000-0000-0000-00000000000b';
    const created = await proposals.create({
      tenantId: otherTenant,
      runId: 'run-1',
      agentId: 'agent-1',
      actionType: 'draft_email_reply',
      payload: { to: 'a@b.com', subject: 's', body: 'b' },
    });
    await proposals.decide(created.id, {
      approverId: 'user-1',
      verdict: 'approved',
      decidedAt: new Date().toISOString(),
    });

    const results = await executeAllApproved({ proposals, audit, registry }, { tenantId: TENANT });
    expect(results).toHaveLength(1);
  });
});

describe('ExecutorRegistry', () => {
  it('registers and looks up by actionType', () => {
    const reg = new ExecutorRegistry();
    const e = recorder('foo');
    reg.register(e);
    expect(reg.has('foo')).toBe(true);
    expect(reg.get('foo')).toBe(e);
    expect(reg.list()).toEqual(['foo']);
  });

  it('throws on duplicate registration', () => {
    const reg = new ExecutorRegistry();
    reg.register(recorder('foo'));
    expect(() => reg.register(recorder('foo'))).toThrow(/already registered/);
  });

  it('returns undefined for unknown actionType', () => {
    const reg = new ExecutorRegistry();
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('nope')).toBe(false);
  });
});
