import { hashPayload } from '@ventus/audit';
import type { AuditStore, Proposal, ProposalStore } from '@ventus/store';
import { effectivePayload, type ExecutorRegistry } from './types.js';

// Orchestrates the post-approval execution step. For each approved proposal:
//   1. Atomically claim the proposal (approved → executing). Prevents two
//      concurrent execute calls from running the same side effect twice.
//   2. Write an audit intent (actor_type=system, action=execute_proposal:<type>)
//   3. Run the executor on the effective payload (reviewer-edited if present)
//   4. On success: write outcome=executed + markExecuted. If either of those
//      audit/state writes fails AFTER the side effect ran, leave the intent as
//      an orphan — never record a fake 'failed' outcome.
//   5. On executor failure: markExecutionFailed + write outcome=failed.
//
// If no executor is registered for the action_type, the proposal is moved to
// 'failed' (claimed but unhandled — surfaces in the inbox for ops).

export interface ExecuteDeps {
  proposals: ProposalStore;
  audit: AuditStore;
  registry: ExecutorRegistry;
  systemActorId?: string;
}

export interface ExecuteResult {
  proposalId: string;
  status: 'executed' | 'failed' | 'skipped';
  result?: unknown;
  error?: string;
}

export async function executeProposal(
  proposalId: string,
  deps: ExecuteDeps,
  opts?: { expectTenantId?: string },
): Promise<ExecuteResult> {
  const peek = await deps.proposals.get(proposalId);
  if (!peek) {
    return { proposalId, status: 'skipped', error: 'proposal not found' };
  }
  // Defense-in-depth: callers (e.g. the HTTP layer) already filter by tenant,
  // but verifying here means a leaked id can never execute against another
  // tenant's proposal even if the upstream check is bypassed or refactored.
  if (opts?.expectTenantId !== undefined && peek.tenantId !== opts.expectTenantId) {
    return {
      proposalId,
      status: 'skipped',
      error: 'proposal not found',
    };
  }
  if (peek.status !== 'approved') {
    return {
      proposalId,
      status: 'skipped',
      error: `proposal is not approved (status=${peek.status})`,
    };
  }
  const claimed = await deps.proposals.beginExecution(proposalId);
  if (!claimed) {
    // Lost the claim race — another caller is/was executing this.
    return {
      proposalId,
      status: 'skipped',
      error: 'proposal could not be claimed (already in flight or no longer approved)',
    };
  }
  return runOne(claimed, deps);
}

export async function executeAllApproved(
  deps: ExecuteDeps,
  filter?: { tenantId?: string },
): Promise<ExecuteResult[]> {
  const pending = await deps.proposals.list({
    tenantId: filter?.tenantId,
    status: 'approved',
  });
  const out: ExecuteResult[] = [];
  for (const p of pending) {
    out.push(await executeProposal(p.id, deps));
  }
  return out;
}

async function runOne(proposal: Proposal, deps: ExecuteDeps): Promise<ExecuteResult> {
  // proposal here is already in status='executing' — beginExecution claimed it.
  const actorId = deps.systemActorId ?? 'executor:cli';
  const executor = deps.registry.get(proposal.actionType);
  const startedAt = Date.now();
  // Audit hash & payload reflect what the executor will ACTUALLY act on
  // (reviewer-edited payload takes precedence). This keeps the audit log
  // tamper-evident with respect to the executed action, not the agent's draft.
  const payload = effectivePayload(proposal);

  const intent = await deps.audit.recordIntent({
    tenantId: proposal.tenantId,
    runId: proposal.runId,
    stepNo: 0,
    actorType: 'system',
    actorId,
    action: `execute_proposal:${proposal.actionType}`,
    resourceType: 'proposal',
    resourceId: proposal.id,
    payload,
    payloadHash: hashPayload(payload),
  });

  if (!executor) {
    const errorText = `no executor registered for action_type=${proposal.actionType}`;
    await deps.audit.recordOutcome({
      intentId: intent.id,
      tenantId: proposal.tenantId,
      status: 'failed',
      errorText,
      durationMs: Date.now() - startedAt,
    });
    await deps.proposals.markExecutionFailed(proposal.id).catch(() => undefined);
    return { proposalId: proposal.id, status: 'failed', error: errorText };
  }

  // Inner try/catch ONLY wraps the executor call. The side effect (sending
  // email, posting Slack, etc.) is the linearization point — once it returns,
  // we treat the action as committed and must not fabricate a 'failed' outcome
  // from a downstream audit/state write failure.
  let result: unknown;
  try {
    result = await executor.execute(proposal, {
      tenantId: proposal.tenantId,
      proposalId: proposal.id,
      approverId: proposal.decision?.approverId ?? 'unknown',
      // proposal.id is a stable UUID assigned at proposal creation. Reusing it
      // as the idempotency key means a crash-then-retry execute (intent
      // already on the audit log, no outcome) replays the same key downstream
      // and the side effect dedupes instead of duplicating. See ExecutorContext
      // comment for why this is defense-in-depth beyond beginExecution.
      idempotencyKey: proposal.id,
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    try {
      await deps.audit.recordOutcome({
        intentId: intent.id,
        tenantId: proposal.tenantId,
        status: 'failed',
        errorText,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // outcome write failed — intent stays as orphan
    }
    await deps.proposals.markExecutionFailed(proposal.id).catch(() => undefined);
    return { proposalId: proposal.id, status: 'failed', error: errorText };
  }

  // Executor succeeded. The remaining writes are best-effort bookkeeping.
  // If they fail, surface the orphan via the audit trail rather than rewriting
  // history to say the executor failed.
  try {
    await deps.audit.recordOutcome({
      intentId: intent.id,
      tenantId: proposal.tenantId,
      status: 'executed',
      result,
      resultHash: hashPayload(result),
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // intent persisted; outcome missing → orphan visible in audit_trail.
  }
  try {
    await deps.proposals.markExecuted(proposal.id);
  } catch {
    // state stuck at 'executing'; reconciliation surfaces this from audit.
  }
  return { proposalId: proposal.id, status: 'executed', result };
}
