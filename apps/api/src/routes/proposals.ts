import { Hono } from 'hono';
import { z } from 'zod';
import { executeProposal } from '@ventus/agent-runtime';
import { hashPayload } from '@ventus/audit';
import type { AuditStore, ProposalStatus, ProposalStore } from '@ventus/store';
import { getAppState } from '../state.js';

// HTTP surface for the proposal approval workflow. Mirrors the proposals CLI:
//   GET    /v1/proposals             list (?status, ?limit)
//   GET    /v1/proposals/:id         fetch one
//   POST   /v1/proposals/:id/decide  approve | reject (body: { verdict, comment?, editedPayload? })
//   POST   /v1/proposals/:id/execute run the registered executor for an approved proposal
//
// Tenant scoping comes from the tenantContext middleware: every list/get/decide
// is scoped to c.var.tenantId. We never trust a tenant id from the request body.

const decideSchema = z
  .object({
    verdict: z.enum(['approved', 'rejected']),
    comment: z.string().optional(),
    editedPayload: z.unknown().optional(),
  })
  .refine((v) => !(v.verdict === 'rejected' && v.editedPayload !== undefined), {
    message: 'editedPayload is only valid with verdict=approved',
    path: ['editedPayload'],
  });

const VALID_STATUSES: ProposalStatus[] = [
  'pending',
  'approved',
  'executing',
  'rejected',
  'executed',
  'failed',
  'expired',
];

function isStatus(v: string): v is ProposalStatus {
  return (VALID_STATUSES as string[]).includes(v);
}

export const proposals = new Hono()
  .get('/', async (c) => {
    const tenantId = c.var.tenantId;
    const statusParam = c.req.query('status');
    const limitParam = c.req.query('limit');

    if (statusParam !== undefined && !isStatus(statusParam)) {
      return c.json({ error: `invalid status: ${statusParam}` }, 400);
    }
    const limit = limitParam !== undefined ? Number(limitParam) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return c.json({ error: 'limit must be a positive integer' }, 400);
    }

    const { proposals: store } = getAppState();
    const rows = await store.list({
      tenantId,
      status: statusParam as ProposalStatus | undefined,
      limit,
    });
    return c.json({ proposals: rows });
  })
  .get('/:id', async (c) => {
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const { proposals: store } = getAppState();
    const p = await store.get(id);
    if (!p || p.tenantId !== tenantId) return c.json({ error: 'not found' }, 404);
    return c.json({ proposal: p });
  })
  .post('/:id/decide', async (c) => {
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const id = c.req.param('id');

    const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.format() }, 400);
    }
    const { verdict, comment, editedPayload } = parsed.data;

    const { proposals: store, audit } = getAppState();
    const existing = await store.get(id);
    if (!existing || existing.tenantId !== tenantId) {
      return c.json({ error: 'not found' }, 404);
    }
    if (existing.status !== 'pending') {
      return c.json(
        { error: `proposal is not pending (status=${existing.status})` },
        409,
      );
    }

    const updated = await decideWithAudit(store, audit, existing.id, {
      tenantId: existing.tenantId,
      runId: existing.runId,
      verdict,
      approverId: userId,
      comment,
      editedPayload,
    });
    return c.json({ proposal: updated });
  })
  .post('/:id/execute', async (c) => {
    const tenantId = c.var.tenantId;
    const id = c.req.param('id');
    const { proposals: store, audit, registry } = getAppState();

    const existing = await store.get(id);
    if (!existing || existing.tenantId !== tenantId) {
      return c.json({ error: 'not found' }, 404);
    }

    const result = await executeProposal(
      id,
      { proposals: store, audit, registry },
      { expectTenantId: tenantId },
    );
    const final = await store.get(id);
    if (result.status === 'executed') {
      return c.json({ result, proposal: final }, 200);
    }
    if (result.status === 'skipped') {
      // skipped errors are user-facing business states ("not approved",
      // "already in flight", "not found") — safe to return verbatim.
      return c.json({ result, proposal: final }, 409);
    }
    // status === 'failed' → 500. result.error is raw executor exception text
    // (or "no executor registered for action_type=..."). Both leak internal
    // detail to clients. Log server-side with proposal/run/tenant ids so we
    // can correlate, and return a generic body. The full audit trail still
    // captures the verbose errorText for forensics.
    // eslint-disable-next-line no-console
    console.error('proposal execute failed', {
      tenantId,
      proposalId: id,
      runId: final?.runId,
      actionType: final?.actionType,
      error: result.error,
    });
    return c.json(
      { error: 'internal error', proposal: final ? { id: final.id, status: final.status } : null },
      500,
    );
  });

interface DecideArgs {
  tenantId: string;
  runId: string;
  verdict: 'approved' | 'rejected';
  approverId: string;
  comment?: string;
  editedPayload?: unknown;
}

async function decideWithAudit(
  store: ProposalStore,
  audit: AuditStore,
  proposalId: string,
  args: DecideArgs,
) {
  const startedAt = Date.now();
  const isEdited = args.editedPayload !== undefined;
  const actionVerdict = isEdited ? 'edited' : args.verdict;
  const payload: Record<string, unknown> = {
    verdict: actionVerdict,
    comment: args.comment ?? null,
  };
  if (isEdited) payload.editedPayload = args.editedPayload;

  const intent = await audit.recordIntent({
    tenantId: args.tenantId,
    runId: args.runId,
    stepNo: 0,
    actorType: 'user',
    actorId: args.approverId,
    action: `decide_proposal:${actionVerdict}`,
    resourceType: 'proposal',
    resourceId: proposalId,
    payload,
    payloadHash: hashPayload(payload),
  });

  try {
    const updated = await store.decide(proposalId, {
      verdict: isEdited ? 'edited' : args.verdict,
      approverId: args.approverId,
      comment: args.comment,
      editedPayload: args.editedPayload,
      decidedAt: new Date().toISOString(),
    });
    await audit.recordOutcome({
      intentId: intent.id,
      tenantId: args.tenantId,
      status: args.verdict === 'approved' ? 'approved' : 'rejected',
      result: { newStatus: updated.status },
      durationMs: Date.now() - startedAt,
    });
    return updated;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    try {
      await audit.recordOutcome({
        intentId: intent.id,
        tenantId: args.tenantId,
        status: 'failed',
        errorText,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // outcome write failed — intent stays as orphan
    }
    throw err;
  }
}
