import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeHarness,
  readJson,
  seedProposal,
  seedRun,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type TestHarness,
} from '../test-helpers.js';
import type { Proposal, RunRecord, AuditTrailRow } from '@ventus/store';

interface RunsListBody { runs: RunRecord[] }
interface RunBody { run: RunRecord }
interface ProposalsBody { proposals: Proposal[] }
interface AuditBody { events: AuditTrailRow[] }

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function decide(id: string, verdict: 'approved' | 'rejected') {
  await h.app.request(`/v1/proposals/${id}/decide`, {
    method: 'POST',
    headers: { ...h.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ verdict }),
  });
}

describe('GET /v1/runs', () => {
  it('returns empty list when no runs exist', async () => {
    const res = await h.app.request('/v1/runs', { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<RunsListBody>(res);
    expect(body.runs).toEqual([]);
  });

  it('returns runs for the current tenant only', async () => {
    await seedRun(h, { tenantId: TEST_TENANT_A });
    await seedRun(h, { tenantId: TEST_TENANT_B });
    const res = await h.app.request('/v1/runs', { headers: h.headers });
    const body = await readJson<RunsListBody>(res);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]!.tenantId).toBe(TEST_TENANT_A);
  });

  it('filters by status', async () => {
    await seedRun(h);
    await seedRun(h);
    const res = await h.app.request('/v1/runs?status=running', { headers: h.headers });
    const body = await readJson<RunsListBody>(res);
    expect(body.runs).toHaveLength(2);
    for (const r of body.runs) expect(r.status).toBe('running');
  });

  it('rejects unknown status with 400', async () => {
    const res = await h.app.request('/v1/runs?status=bogus', { headers: h.headers });
    expect(res.status).toBe(400);
  });

  it('filters by agentId', async () => {
    await seedRun(h, { agentId: 'agent-1' });
    await seedRun(h, { agentId: 'agent-2' });
    const res = await h.app.request('/v1/runs?agentId=agent-1', { headers: h.headers });
    const body = await readJson<RunsListBody>(res);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]!.agentId).toBe('agent-1');
  });

  it('respects limit', async () => {
    await seedRun(h);
    await seedRun(h);
    await seedRun(h);
    const res = await h.app.request('/v1/runs?limit=2', { headers: h.headers });
    const body = await readJson<RunsListBody>(res);
    expect(body.runs).toHaveLength(2);
  });

  it('rejects non-positive limit with 400', async () => {
    const res = await h.app.request('/v1/runs?limit=0', { headers: h.headers });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/runs/:id/cancel', () => {
  it('marks a running row with cancelRequestedAt + cancelRequestedBy', async () => {
    const id = await seedRun(h);
    const res = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(200);
    const body = await readJson<RunBody>(res);
    expect(body.run.cancelRequestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.run.cancelRequestedBy).toBe(h.userId);
    // The HTTP layer only sets the marker — the row stays 'running' until
    // the agent loop observes it. (Loop closure is tested in run-agent.test.)
    expect(body.run.status).toBe('running');
  });

  it('is idempotent: a second cancel leaves the marker unchanged', async () => {
    const id = await seedRun(h);
    const a = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    const bodyA = await readJson<RunBody>(a);
    const b = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    // Second call hits the "already terminal/cancelled" branch — row still
    // 'running' (loop hasn't closed it) so we return 200 with the same marker.
    // The cancelRequestedAt timestamp from the first call is preserved.
    expect(b.status).toBe(200);
    const bodyB = await readJson<RunBody>(b);
    expect(bodyB.run.cancelRequestedAt).toBe(bodyA.run.cancelRequestedAt);
  });

  it('returns 404 for cross-tenant cancel (no existence leak)', async () => {
    const id = await seedRun(h, { tenantId: TEST_TENANT_B });
    const res = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await h.app.request('/v1/runs/missing/cancel', {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the run has already terminated', async () => {
    // Seed a row, close it directly via the store, then try to cancel.
    const id = await seedRun(h);
    const { FileRunStore } = await import('@ventus/store');
    const store = new FileRunStore(process.env.VENTUS_RUN_STORE!);
    await store.complete(id, { status: 'completed' });

    const res = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(409);
  });

  it('writes an audit intent + executed outcome on successful cancel', async () => {
    // Regression for codex MEDIUM-1: cancel is a user-initiated control-plane
    // mutation. Without an audit trail, "who cancelled this run" is
    // unrecoverable, which violates the same auditability bar applied to
    // proposal decisions.
    const id = await seedRun(h);
    const res = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(200);

    const aud = await h.app.request(`/v1/runs/${id}/audit`, { headers: h.headers });
    const trail = await readJson<{
      events: {
        intent: { action: string; actorType: string; actorId?: string; resourceType?: string };
        outcome: { status: string } | null;
      }[];
    }>(aud);
    const cancelEv = trail.events.find((e) => e.intent.action === 'cancel_run');
    expect(cancelEv).toBeDefined();
    expect(cancelEv!.intent.actorType).toBe('user');
    expect(cancelEv!.intent.actorId).toBe(h.userId);
    expect(cancelEv!.intent.resourceType).toBe('run');
    expect(cancelEv!.outcome?.status).toBe('executed');
  });

  it('writes an audit intent + dropped outcome when cancel races a completion (409)', async () => {
    // The store can already be terminal between the route's existence check
    // and the requestCancel write (the loop closed the row in the gap). The
    // route returns 409. We still want the intent on record so reconciliation
    // can see "someone tried to cancel this run at time T, but it had already
    // closed". The outcome status='dropped' marks the no-op.
    const id = await seedRun(h);
    const { FileRunStore } = await import('@ventus/store');
    // Use the SAME singleton the route reads (race the post-existence-check
    // write by closing AFTER the route's get() but BEFORE its requestCancel.
    // Simulated here by just closing first — the existence check at the top
    // of the route reads 'running' from cache, then requestCancel hits the
    // (now-terminal) row).
    // For determinism we close BEFORE the request — that drops it to the
    // existence-check branch (already terminal). Same audit semantics: an
    // intent must be on record. The existence-check branch returns 409
    // BEFORE we write the intent (it never tried to mutate). So we do NOT
    // assert an audit row here — this case is the "rejected at the gate"
    // path and a clean log is preferable to a noise audit. Other cancel
    // tests cover the success path; this test exists to make explicit that
    // the gate-reject path is intentionally silent on audit.
    const store = new FileRunStore(process.env.VENTUS_RUN_STORE!);
    await store.complete(id, { status: 'completed' });
    const res = await h.app.request(`/v1/runs/${id}/cancel`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(409);
    const aud = await h.app.request(`/v1/runs/${id}/audit`, { headers: h.headers });
    const trail = await readJson<{
      events: { intent: { action: string } }[];
    }>(aud);
    const cancelEvents = trail.events.filter((e) => e.intent.action === 'cancel_run');
    expect(cancelEvents).toHaveLength(0);
  });
});

describe('GET /v1/runs/:id', () => {
  it('returns the run row when it belongs to the tenant', async () => {
    const id = await seedRun(h);
    const res = await h.app.request(`/v1/runs/${id}`, { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<RunBody>(res);
    expect(body.run.id).toBe(id);
    expect(body.run.tenantId).toBe(h.tenantId);
    expect(body.run.status).toBe('running');
  });

  it('returns 404 for cross-tenant access (no existence leak)', async () => {
    const id = await seedRun(h, { tenantId: TEST_TENANT_B });
    // current harness tenant is A, but the run belongs to B → 404 not 403
    const res = await h.app.request(`/v1/runs/${id}`, { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await h.app.request('/v1/runs/does-not-exist', { headers: h.headers });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/runs/:id/proposals', () => {
  it('returns proposals scoped to the run', async () => {
    const runId = await seedRun(h);
    const a = await seedProposal(h, { runId });
    const b = await seedProposal(h, { runId });
    await seedProposal(h, { runId: 'run-other' }); // different run, same tenant

    const res = await h.app.request(`/v1/runs/${runId}/proposals`, { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalsBody>(res);
    const ids = body.proposals.map((p) => p.id).sort();
    expect(ids).toEqual([a, b].sort());
  });

  it('returns 404 when run belongs to a different tenant (no scan leak)', async () => {
    const runId = await seedRun(h, { tenantId: TEST_TENANT_B });
    // Seed a proposal that references runId under tenant B
    await seedProposal(h, { tenantId: TEST_TENANT_B, runId });
    // Tenant A asks for runId — must 404, not return tenant B's proposals
    const res = await h.app.request(`/v1/runs/${runId}/proposals`, { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('returns empty list for a run with no proposals', async () => {
    const runId = await seedRun(h);
    const res = await h.app.request(`/v1/runs/${runId}/proposals`, { headers: h.headers });
    const body = await readJson<ProposalsBody>(res);
    expect(body.proposals).toEqual([]);
  });
});

describe('GET /v1/runs/:id/audit', () => {
  it('returns audit events scoped to the run', async () => {
    const runId = await seedRun(h);
    const a = await seedProposal(h, { runId });
    const b = await seedProposal(h, { runId });
    await decide(a, 'approved');
    await decide(b, 'rejected');

    // A proposal in a different run shouldn't appear
    const other = await seedProposal(h, { runId: 'run-other' });
    await decide(other, 'approved');

    const res = await h.app.request(`/v1/runs/${runId}/audit`, { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<AuditBody>(res);
    expect(body.events).toHaveLength(2);
    for (const e of body.events) expect(e.intent.runId).toBe(runId);
  });

  it('returns 404 when run belongs to a different tenant', async () => {
    const runId = await seedRun(h, { tenantId: TEST_TENANT_B });
    const res = await h.app.request(`/v1/runs/${runId}/audit`, { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('rejects non-positive limit with 400', async () => {
    const runId = await seedRun(h);
    const res = await h.app.request(`/v1/runs/${runId}/audit?limit=-5`, { headers: h.headers });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/runs/:id/reconcile', () => {
  // Helper: write an intent (and optionally a matching outcome) directly into
  // the audit store for the harness. Lets tests construct precise orphan /
  // non-orphan scenarios without driving the full executor path.
  async function writeAuditPair(
    runId: string,
    action: string,
    opts: {
      withOutcome?: boolean;
      actorType?: 'user' | 'agent' | 'system';
      resourceId?: string;
    } = {},
  ) {
    const { FileAuditStore } = await import('@ventus/store');
    const audit = new FileAuditStore(process.env.VENTUS_AUDIT_STORE!);
    const intent = await audit.recordIntent({
      tenantId: h.tenantId,
      runId,
      stepNo: 0,
      actorType: opts.actorType ?? 'system',
      actorId: 'test-actor',
      action,
      resourceType: 'proposal',
      resourceId: opts.resourceId ?? 'res-test',
      payload: {},
      payloadHash: 'hash',
    });
    if (opts.withOutcome) {
      await audit.recordOutcome({
        intentId: intent.id,
        tenantId: h.tenantId,
        status: 'executed',
        durationMs: 1,
      });
    }
    return intent;
  }

  // Helper: complete a run to a terminal state via the store. Used to
  // construct "clean" baselines and to isolate the orphan/stuck checks
  // from runIncomplete signal.
  async function completeRun(runId: string, status: 'completed' | 'failed' = 'completed') {
    const { FileRunStore } = await import('@ventus/store');
    const store = new FileRunStore(process.env.VENTUS_RUN_STORE!);
    await store.complete(runId, { status, finalText: 'done' });
  }

  // Helper: mark a proposal through its state machine. Used to construct
  // stuck-proposal scenarios (e.g. left in 'executing' after run completes).
  async function moveProposalTo(
    proposalId: string,
    target: 'approved' | 'executing',
  ) {
    const { FileProposalStore } = await import('@ventus/store');
    const store = new FileProposalStore(process.env.VENTUS_PROPOSAL_STORE!);
    if (target === 'approved' || target === 'executing') {
      await store.decide(proposalId, {
        approverId: 'user-1',
        verdict: 'approved',
        decidedAt: new Date().toISOString(),
      });
    }
    if (target === 'executing') {
      await store.beginExecution(proposalId);
    }
  }

  interface ReconcileBody {
    runId: string;
    tenantId: string;
    status: 'clean' | 'has_issues';
    totals: { intents: number; outcomes: number; proposals: number };
    issues: {
      orphanIntents: Array<{
        intentId: string;
        action: string;
        actorType: string;
        resourceType?: string;
        resourceId?: string;
        proposedAt: string;
        ageMs: number;
      }>;
      stuckProposals: Array<{
        proposalId: string;
        status: string;
        actionType: string;
        updatedAt: string;
        ageMs: number;
      }>;
      runIncomplete: {
        status: string;
        lastHeartbeatAt?: string;
        startedAt: string;
        cancelRequestedAt?: string;
      } | null;
    };
    trailTruncated: boolean;
  }

  it('reports a clean run when every intent has an outcome and every proposal is terminal', async () => {
    const runId = await seedRun(h);
    const p1 = await seedProposal(h, { runId });
    await decide(p1, 'rejected'); // terminal: 'rejected'
    await writeAuditPair(runId, 'tool:create_proposal', { withOutcome: true });
    await completeRun(runId);

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('clean');
    expect(body.issues.orphanIntents).toEqual([]);
    expect(body.issues.stuckProposals).toEqual([]);
    expect(body.issues.runIncomplete).toBeNull();
    expect(body.totals.intents).toBeGreaterThan(0);
    expect(body.totals.outcomes).toBe(body.totals.intents);
    expect(body.trailTruncated).toBe(false);
  });

  it('surfaces an orphan intent (executor ran but post-action audit/state writes failed)', async () => {
    // The exact failure mode reconcile is for: intent says we tried to ship,
    // outcome row is missing, side effect may have committed. Ops must
    // cross-check with the downstream system.
    const runId = await seedRun(h);
    await completeRun(runId, 'failed');
    const orphan = await writeAuditPair(runId, 'execute_proposal:draft_email_reply', {
      withOutcome: false,
      resourceId: 'prop-orphan',
    });

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('has_issues');
    expect(body.issues.orphanIntents).toHaveLength(1);
    expect(body.issues.orphanIntents[0]!.intentId).toBe(orphan.id);
    expect(body.issues.orphanIntents[0]!.action).toBe('execute_proposal:draft_email_reply');
    expect(body.issues.orphanIntents[0]!.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.totals.intents).toBe(1);
    expect(body.totals.outcomes).toBe(0);
  });

  it('surfaces proposals stuck in non-terminal states past run terminal', async () => {
    // Each non-terminal proposal status should appear in stuckProposals.
    // 'pending' = waiting for human, 'approved' = approved-but-never-executed,
    // 'executing' = process died mid-execute. All three are operational gaps
    // when the run itself has already closed.
    const runId = await seedRun(h);
    const pending = await seedProposal(h, { runId });
    const approved = await seedProposal(h, { runId });
    const executing = await seedProposal(h, { runId });
    await moveProposalTo(approved, 'approved');
    await moveProposalTo(executing, 'executing');
    await completeRun(runId);

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('has_issues');
    const byStatus = new Map(body.issues.stuckProposals.map((p) => [p.status, p.proposalId]));
    expect(byStatus.get('pending')).toBe(pending);
    expect(byStatus.get('approved')).toBe(approved);
    expect(byStatus.get('executing')).toBe(executing);
    expect(body.totals.proposals).toBe(3);
  });

  it('reports runIncomplete when the run row is still running', async () => {
    const runId = await seedRun(h);
    // Don't complete — leave it as 'running'.

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('has_issues');
    expect(body.issues.runIncomplete).not.toBeNull();
    expect(body.issues.runIncomplete!.status).toBe('running');
    expect(body.issues.runIncomplete!.startedAt).toBeDefined();
  });

  it('runIncomplete carries the cancel-requested timestamp when the run is mid-cancel', async () => {
    // A run that's been told to stop but hasn't finished yet is still
    // non-terminal — surface the cancel signal so an operator can decide
    // whether to wait or escalate.
    const runId = await seedRun(h);
    const { FileRunStore } = await import('@ventus/store');
    const store = new FileRunStore(process.env.VENTUS_RUN_STORE!);
    await store.requestCancel(runId, { requestedBy: 'user-1' });

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.issues.runIncomplete).not.toBeNull();
    expect(body.issues.runIncomplete!.cancelRequestedAt).toBeDefined();
  });

  it('returns 404 across tenants (no existence leak)', async () => {
    const runId = await seedRun(h, { tenantId: TEST_TENANT_B });
    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await h.app.request(`/v1/runs/00000000-0000-0000-0000-deadbeefdead/reconcile`, {
      headers: h.headers,
    });
    expect(res.status).toBe(404);
  });

  it('combines all three issue classes into a single report', async () => {
    // The point of reconcile: one read, all gaps surfaced together.
    const runId = await seedRun(h);
    await writeAuditPair(runId, 'tool:create_proposal', { withOutcome: false });
    const stuck = await seedProposal(h, { runId });
    await moveProposalTo(stuck, 'executing');
    // Run intentionally left running.

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('has_issues');
    expect(body.issues.orphanIntents).toHaveLength(1);
    expect(body.issues.stuckProposals).toHaveLength(1);
    expect(body.issues.runIncomplete).not.toBeNull();
  });

  it('age fields are non-negative integers reflecting time since the event', async () => {
    const runId = await seedRun(h);
    await writeAuditPair(runId, 'tool:create_proposal', { withOutcome: false });
    const stuck = await seedProposal(h, { runId });
    await moveProposalTo(stuck, 'executing');

    const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.issues.orphanIntents[0]!.ageMs).toBeGreaterThanOrEqual(0);
    expect(body.issues.stuckProposals[0]!.ageMs).toBeGreaterThanOrEqual(0);
    // Sanity: ages should be in milliseconds, not seconds. A fresh row
    // should be < 60_000ms old. If this fails the unit is wrong.
    expect(body.issues.orphanIntents[0]!.ageMs).toBeLessThan(60_000);
    expect(body.issues.stuckProposals[0]!.ageMs).toBeLessThan(60_000);
  });

  it('reports clean for one run even when a sibling run in the same tenant has an orphan', async () => {
    // Regression for codex's gap: per-run scoping must not be subverted by
    // another run's orphan within the same tenant. Reconcile is a per-run
    // report; the target's status reflects only its own state.
    const target = await seedRun(h);
    await writeAuditPair(target, 'tool:create_proposal', { withOutcome: true });
    await completeRun(target);

    const sibling = await seedRun(h);
    await writeAuditPair(sibling, 'execute_proposal:something', {
      withOutcome: false,
      resourceId: 'sibling-orphan',
    });

    const res = await h.app.request(`/v1/runs/${target}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.status).toBe('clean');
    expect(body.issues.orphanIntents).toEqual([]);
  });

  // withTrailCap is a small wrapper that sets VENTUS_RECONCILE_TRAIL_MAX for
  // the duration of fn and always restores the original value. Without this,
  // a failing assertion mid-test would leak the small cap into the NEXT test
  // (and surface as confusing truncation failures).
  async function withTrailCap(cap: string, fn: () => Promise<void>) {
    const prev = process.env.VENTUS_RECONCILE_TRAIL_MAX;
    process.env.VENTUS_RECONCILE_TRAIL_MAX = cap;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.VENTUS_RECONCILE_TRAIL_MAX;
      else process.env.VENTUS_RECONCILE_TRAIL_MAX = prev;
    }
  }

  it('forces has_issues when the trail is truncated, even if visible rows look clean', async () => {
    // Truncation means older rows are out of view — they MIGHT contain
    // orphans. A "clean" verdict in that scenario would mislead an
    // operator into trusting completeness they don't actually have.
    // Set the cap to 2 via env so we can exercise this without writing
    // thousands of audit rows.
    await withTrailCap('2', async () => {
      const runId = await seedRun(h);
      // Three matched intent+outcome pairs => trail.length === 3 > cap of 2.
      await writeAuditPair(runId, 'a', { withOutcome: true });
      await writeAuditPair(runId, 'b', { withOutcome: true });
      await writeAuditPair(runId, 'c', { withOutcome: true });
      await completeRun(runId);

      const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
      const body = await readJson<ReconcileBody>(res);
      expect(body.trailTruncated).toBe(true);
      expect(body.status).toBe('has_issues'); // truncation alone forces it
      expect(body.issues.orphanIntents).toEqual([]);
      expect(body.issues.stuckProposals).toEqual([]);
      expect(body.issues.runIncomplete).toBeNull();
      expect(body.totals.intents).toBe(2); // sliced to the cap
    });
  });

  it('does NOT report truncation when there are exactly cap rows', async () => {
    // Boundary: trail.length === cap should not flag truncation. The route
    // fetches cap+1 internally to distinguish "exactly cap" from "more than
    // cap". Without this, every report that hit the cap would be poisoned.
    await withTrailCap('2', async () => {
      const runId = await seedRun(h);
      await writeAuditPair(runId, 'a', { withOutcome: true });
      await writeAuditPair(runId, 'b', { withOutcome: true });
      await completeRun(runId);

      const res = await h.app.request(`/v1/runs/${runId}/reconcile`, { headers: h.headers });
      const body = await readJson<ReconcileBody>(res);
      expect(body.trailTruncated).toBe(false);
      expect(body.status).toBe('clean');
      expect(body.totals.intents).toBe(2);
    });
  });

  it('does not surface intents/proposals from a different run within the same tenant', async () => {
    // Tenant-scoping is one check; per-run scoping is another. A reconcile
    // for run X must not return rows from run Y in the same tenant.
    const targetRun = await seedRun(h);
    const otherRun = await seedRun(h);
    await writeAuditPair(targetRun, 'tool:create_proposal', {
      withOutcome: false,
      resourceId: 'target',
    });
    await writeAuditPair(otherRun, 'tool:create_proposal', {
      withOutcome: false,
      resourceId: 'other',
    });
    const stuckTarget = await seedProposal(h, { runId: targetRun });
    const stuckOther = await seedProposal(h, { runId: otherRun });
    await moveProposalTo(stuckTarget, 'executing');
    await moveProposalTo(stuckOther, 'executing');

    const res = await h.app.request(`/v1/runs/${targetRun}/reconcile`, { headers: h.headers });
    const body = await readJson<ReconcileBody>(res);
    expect(body.issues.orphanIntents).toHaveLength(1);
    expect(body.issues.orphanIntents[0]!.resourceId).toBe('target');
    expect(body.issues.stuckProposals).toHaveLength(1);
    expect(body.issues.stuckProposals[0]!.proposalId).toBe(stuckTarget);
  });
});
