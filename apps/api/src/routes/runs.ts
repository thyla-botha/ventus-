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

    // getRuntime() throws when ANTHROPIC_API_KEY is missing — surface as 503
    // so callers can distinguish "infra not configured" from "bad input".
    // Anything else is a real server fault: log it and return generic 500
    // without echoing the error message (it could include stack frames /
    // file paths that leak deployment details).
    let runtime;
    try {
      runtime = state.getRuntime();
    } catch (err) {
      state.releaseRunSlot(tenantId);
      const text = err instanceof Error ? err.message : String(err);
      if (/ANTHROPIC_API_KEY/.test(text)) {
        return c.json({ error: 'runtime not configured' }, 503);
      }
      // eslint-disable-next-line no-console
      console.error('POST /v1/runs getRuntime() failed:', err);
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
        { skill, tenantId, agentId, userMessage: message },
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
  });
