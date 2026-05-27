import { Hono } from 'hono';
import { z } from 'zod';
import { startRunAgent } from '@ventus/agent-runtime';
import { hashPayload } from '@ventus/audit';
import type { RunStatus } from '@ventus/store';
import { getAppState } from '../state.js';

// HTTP surface for run provenance. Tenant scoping comes from the
// tenantContext middleware — we never trust a tenant id from the request
// body and never return a row whose tenantId does not match c.var.tenantId.
//
//   POST /v1/runs                      kick off an agent loop (returns immediately)
//   GET  /v1/runs                      list (?status, ?agentId, ?limit)
//   GET  /v1/runs/:id                  fetch one
//   POST /v1/runs/:id/cancel           request the loop stops (status→aborted)
//   GET  /v1/runs/:id/proposals        proposals produced during this run
//   GET  /v1/runs/:id/audit            audit trail scoped to this run
//   GET  /v1/runs/:id/reconcile        regulator-facing report — orphan intents,
//                                       stuck proposals, run-state consistency

const VALID_STATUSES: RunStatus[] = [
  'running',
  'completed',
  'failed',
  'halted',
  'aborted',
];

function isStatus(v: string): v is RunStatus {
  return (VALID_STATUSES as string[]).includes(v);
}

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

// Reconcile pulls the full audit trail for one run to detect orphans. The
// hard ceiling protects against pathological runs that produced thousands of
// events; the route doesn't paginate (a regulator-facing report should be
// self-contained), but we cap so the read can't blow memory. A real prod run
// with > MAX_RECONCILE_TRAIL rows is itself a P1 signal — flag it loudly via
// the trailTruncated field, AND force status=has_issues so a truncated
// report never reads as "clean" (older rows may contain orphans we didn't
// see). Configurable via VENTUS_RECONCILE_TRAIL_MAX so tests can exercise
// the truncation path without writing 5000 audit rows.
const DEFAULT_RECONCILE_TRAIL_MAX = 5_000;
function readReconcileTrailMax(): number {
  const raw = process.env.VENTUS_RECONCILE_TRAIL_MAX;
  if (!raw) return DEFAULT_RECONCILE_TRAIL_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    return DEFAULT_RECONCILE_TRAIL_MAX;
  }
  return n;
}

// Proposal statuses considered "non-terminal" — these are surfaced as
// stuckProposals so the caller can decide what's an in-flight workflow vs.
// a leaked row. The reconcile endpoint deliberately doesn't impose its own
// age threshold; raw ages let the caller apply their SLA.
const NON_TERMINAL_PROPOSAL_STATUSES = new Set([
  'pending',
  'approved',
  'executing',
]);
const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'failed',
  'halted',
  'aborted',
]);

// modelOverride is intentionally NOT exposed here. The CLI accepts it for dev
// flexibility, but over HTTP it would let any tenant bypass the skill's model
// policy (and break cost accounting for unknown models). When/if we want a
// "dev mode" override we'll gate it behind an admin role + allowlist.
// Length caps: stop unbounded prompts from running up tokens/storage. The
// schema bounds are well above any reasonable real input but small enough
// that file-store rows stay manageable. Adjust together with skill token
// budgets if user messages legitimately need to grow.
const MAX_MESSAGE_LEN = 8_000;
const MAX_AGENT_ID_LEN = 128;
const MAX_SKILL_NAME_LEN = 128;

const createRunSchema = z.object({
  skillName: z.string().min(1).max(MAX_SKILL_NAME_LEN),
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  agentId: z.string().min(1).max(MAX_AGENT_ID_LEN).optional(),
});

export const runs = new Hono()
  .post('/', async (c) => {
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;

    const parsed = createRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.format() }, 400);
    }
    const { skillName, message } = parsed.data;
    const agentId = parsed.data.agentId ?? `api:${userId}`;

    const state = getAppState();
    const allSkills = await state.getSkills();
    const skill = allSkills.find((s) => s.name === skillName);
    if (!skill) return c.json({ error: `unknown skill: ${skillName}` }, 404);

    // Per-tenant concurrency cap. We deliberately claim AFTER body parse
    // and skill lookup so malformed requests still get proper 400/404 codes
    // without counting against the cap — a tenant flooding bogus payloads
    // is a separate rate-limit problem, not a concurrency one. The claim
    // runs BEFORE runtime construction and runs.create() so overflow is
    // cheap. Must be released on EVERY exit path below — early returns
    // release explicitly, the success path chains release onto
    // handle.completion via .finally().
    if (!state.tryClaimRunSlot(tenantId)) {
      return c.json(
        {
          error: 'tenant at concurrent-run cap',
          cap: state.perTenantRunCap,
        },
        429,
      );
    }

    // resolveRuntimeForTenant() throws when the resolved provider's
    // constructor fails (e.g. ANTHROPIC_API_KEY missing on the deployment
    // default, or an open-source provider's baseURL is unreachable at
    // construction). Surface as 503 so callers can distinguish "infra not
    // configured" from "bad input". Anything else is a real server fault.
    let runtime;
    let modelOverride: string | undefined;
    try {
      const resolved = await state.resolveRuntimeForTenant(tenantId);
      runtime = resolved.runtime;
      modelOverride = resolved.modelOverride;
    } catch (err) {
      state.releaseRunSlot(tenantId);
      const text = err instanceof Error ? err.message : String(err);
      if (/ANTHROPIC_API_KEY|OPENROUTER_API_KEY|API_KEY/i.test(text)) {
        return c.json({ error: 'runtime not configured' }, 503);
      }
      // eslint-disable-next-line no-console
      console.error('POST /v1/runs resolveRuntimeForTenant() failed:', err);
      return c.json({ error: 'internal error' }, 500);
    }

    let handle;
    try {
      handle = await startRunAgent(
        {
          proposals: state.proposals,
          audit: state.audit,
          runs: state.runs,
          runtime,
          tenantProfiles: state.tenantProfiles,
        },
        { skill, tenantId, agentId, userMessage: message, modelOverride },
      );
    } catch (err) {
      state.releaseRunSlot(tenantId);
      // startRunAgent only fails before the loop starts (e.g. runs.create()
      // write failed). The Run row isn't open yet, so there's nothing to
      // close — just log and 500.
      // eslint-disable-next-line no-console
      console.error('POST /v1/runs startRunAgent failed:', err);
      return c.json({ error: 'failed to start run' }, 500);
    }

    // Release the slot whenever the loop settles (resolve OR reject). We
    // wrap the same promise that goes to trackInflight so the two concerns
    // — drain semantics and slot accounting — stay independent.
    const settled = handle.completion.finally(() => state.releaseRunSlot(tenantId));
    // Track the background completion on AppState so graceful shutdown (and
    // tests) can drain it before exiting. trackInflight() swallows rejections
    // internally — the loop already records failures on the Run row, so this
    // is purely a safety net against unhandled rejections.
    state.trackInflight(settled);

    return c.json({ run: handle.run }, 202);
  })
  .get('/', async (c) => {
    const tenantId = c.var.tenantId;
    const statusParam = c.req.query('status');
    const agentId = c.req.query('agentId');
    const limitParam = c.req.query('limit');

    if (statusParam !== undefined && !isStatus(statusParam)) {
      return c.json({ error: `invalid status: ${statusParam}` }, 400);
    }
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }

    const { runs: store } = getAppState();
    const rows = await store.list({
      tenantId,
      status: statusParam as RunStatus | undefined,
      agentId,
      limit,
    });
    return c.json({ runs: rows });
  })
  .get('/:id', async (c) => {
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const { runs: store } = getAppState();
    const r = await store.get(id);
    if (!r || r.tenantId !== tenantId) return c.json({ error: 'not found' }, 404);
    return c.json({ run: r });
  })
  .post('/:id/cancel', async (c) => {
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const id = c.req.param('id');
    const { runs: store, audit } = getAppState();

    // Verify the run exists in this tenant BEFORE attempting cancel. Without
    // the tenant check, a caller could probe run-id existence across tenants
    // by observing 200 vs. 404 from requestCancel.
    const existing = await store.get(id);
    if (!existing || existing.tenantId !== tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    // Already terminal — surface as 409 so the UI can disable the button.
    if (existing.status !== 'running') {
      return c.json(
        { error: `run is not running (status=${existing.status})`, run: existing },
        409,
      );
    }

    // Audit the cancel request BEFORE the store write so the intent is on
    // record even if the requestCancel write fails. Cancels are a
    // control-plane mutation — same auditability bar as proposal decisions.
    const intentStartedAt = Date.now();
    const intentPayload = { runId: id };
    const intent = await audit.recordIntent({
      tenantId,
      runId: id,
      stepNo: 0,
      actorType: 'user',
      actorId: userId,
      action: 'cancel_run',
      resourceType: 'run',
      resourceId: id,
      payload: intentPayload,
      payloadHash: hashPayload(intentPayload),
    });

    let updated;
    try {
      updated = await store.requestCancel(id, { requestedBy: userId });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await audit.recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - intentStartedAt,
        });
      } catch {
        // outcome write failed — intent stays as an orphan on the trail.
      }
      throw err;
    }

    // requestCancel returning null here would mean the row vanished between
    // the get() and the requestCancel(), which we treat as a 404.
    if (!updated) {
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'dropped',
          errorText: 'run vanished between read and cancel',
          durationMs: Date.now() - intentStartedAt,
        })
        .catch(() => undefined);
      return c.json({ error: 'not found' }, 404);
    }
    // Race window: the loop may have completed BETWEEN our get() and the
    // requestCancel() store write. In that case requestCancel was a no-op
    // (it refuses to set a marker on a terminal row) and the cancel had no
    // effect. Surface as 409 so the UI doesn't show "cancelled" for a run
    // that actually completed. Codex caught this; without the re-check
    // callers would see a misleading 200.
    if (updated.status !== 'running') {
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'dropped',
          result: { reason: 'run already terminal', status: updated.status },
          durationMs: Date.now() - intentStartedAt,
        })
        .catch(() => undefined);
      return c.json(
        { error: `run is not running (status=${updated.status})`, run: updated },
        409,
      );
    }

    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId,
        status: 'executed',
        result: { cancelRequestedAt: updated.cancelRequestedAt },
        durationMs: Date.now() - intentStartedAt,
      })
      .catch(() => undefined);

    return c.json({ run: updated });
  })
  .get('/:id/proposals', async (c) => {
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const { runs: runStore, proposals: proposalStore } = getAppState();

    // Verify the run exists and belongs to this tenant BEFORE filtering. Without
    // this, a 404 vs. empty list would leak whether a run id exists in any tenant.
    const run = await runStore.get(id);
    if (!run || run.tenantId !== tenantId) return c.json({ error: 'not found' }, 404);

    const rows = await proposalStore.list({ tenantId, runId: id });
    return c.json({ proposals: rows });
  })
  .get('/:id/audit', async (c) => {
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const limitParam = c.req.query('limit');

    let limit = limitParam !== undefined ? Number(limitParam) : DEFAULT_AUDIT_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }
    if (limit > MAX_AUDIT_LIMIT) limit = MAX_AUDIT_LIMIT;

    const { runs: runStore, audit: auditStore } = getAppState();
    const run = await runStore.get(id);
    if (!run || run.tenantId !== tenantId) return c.json({ error: 'not found' }, 404);

    const rows = await auditStore.listAuditTrail({ tenantId, runId: id, limit });
    return c.json({ events: rows });
  })
  .get('/:id/reconcile', async (c) => {
    // Reconciliation report for ONE run. Read-only — no audit row is written
    // for this call itself (an audit-of-the-audit would be infinite regress,
    // and reads of operational data don't carry the same compliance weight as
    // tenant_profile reads or proposal decisions). The report enumerates the
    // three classes of integrity issue this platform can leak under crashes:
    //
    //   1. orphanIntents — intent recorded but no outcome row. Indicates the
    //      executor ran (side effect may have committed) but the post-action
    //      audit/state writes failed. The intent payload + actorType identify
    //      what side effect to manually verify against the downstream system
    //      (e.g. outbox row for emails, Slack thread for messages).
    //   2. stuckProposals — proposals in pending/approved/executing past the
    //      run's terminal point. A run that completed but left a proposal in
    //      'executing' means the executor crashed; the operator must inspect
    //      and either mark failed (if the side effect didn't commit) or
    //      mark executed (if it did, by matching outbox/external system).
    //   3. runIncomplete — the run itself is non-terminal. Either still
    //      running (caller can re-poll) or stuck (reaper should close it,
    //      but may not have run yet).
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const { runs: runStore, audit: auditStore, proposals: proposalStore } = getAppState();

    const run = await runStore.get(id);
    if (!run || run.tenantId !== tenantId) return c.json({ error: 'not found' }, 404);

    // Pull at most MAX rows. Fetch MAX+1 so we can distinguish "exactly MAX
    // matching rows, no truncation" from "more than MAX rows, truncated"
    // — without the extra row the boundary case (length === MAX) would always
    // read as truncated, costing us false-positive operational noise.
    const trailMax = readReconcileTrailMax();
    const trailRaw = await auditStore.listAuditTrail({
      tenantId,
      runId: id,
      limit: trailMax + 1,
    });
    const trailTruncated = trailRaw.length > trailMax;
    const trail = trailTruncated ? trailRaw.slice(0, trailMax) : trailRaw;
    const outcomeCount = trail.reduce((n, row) => (row.outcome ? n + 1 : n), 0);

    const now = Date.now();
    const orphanIntents = trail
      .filter((row) => row.outcome === null)
      .map((row) => ({
        intentId: row.intent.id,
        action: row.intent.action,
        actorType: row.intent.actorType,
        resourceType: row.intent.resourceType,
        resourceId: row.intent.resourceId,
        proposedAt: row.intent.proposedAt,
        ageMs: now - new Date(row.intent.proposedAt).getTime(),
      }));

    // Proposals for this run. We pass tenantId AND runId so the file-store's
    // tenant filter still runs at the read layer — defense-in-depth even
    // though we already verified the run's tenant above.
    const proposals = await proposalStore.list({ tenantId, runId: id });
    const stuckProposals = proposals
      .filter((p) => NON_TERMINAL_PROPOSAL_STATUSES.has(p.status))
      .map((p) => ({
        proposalId: p.id,
        status: p.status,
        actionType: p.actionType,
        updatedAt: p.updatedAt,
        ageMs: now - new Date(p.updatedAt).getTime(),
      }));

    const runIncomplete = TERMINAL_RUN_STATUSES.has(run.status)
      ? null
      : {
          status: run.status,
          lastHeartbeatAt: run.lastHeartbeatAt,
          startedAt: run.startedAt,
          cancelRequestedAt: run.cancelRequestedAt,
        };

    // Truncation forces has_issues so a report cut short by the trail cap
    // never reads as "clean" — the omitted rows MIGHT contain orphans we
    // didn't see. The trailTruncated flag is the precise signal; status is
    // the safe-default summary.
    const hasIssues =
      orphanIntents.length > 0 ||
      stuckProposals.length > 0 ||
      runIncomplete !== null ||
      trailTruncated;

    return c.json({
      runId: run.id,
      tenantId: run.tenantId,
      status: hasIssues ? 'has_issues' : 'clean',
      totals: {
        intents: trail.length,
        outcomes: outcomeCount,
        proposals: proposals.length,
      },
      issues: {
        orphanIntents,
        stuckProposals,
        runIncomplete,
      },
      trailTruncated,
    });
  });
