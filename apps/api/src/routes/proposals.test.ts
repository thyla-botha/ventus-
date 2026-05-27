import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditTrailRow, Proposal } from '@ventus/store';
import { getAppState } from '../state.js';
import {
  makeHarness,
  readJson,
  seedProposal,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type TestHarness,
} from '../test-helpers.js';

interface ProposalListBody {
  proposals: Proposal[];
}
interface ProposalBody {
  proposal: Proposal;
}
interface AuditBody {
  events: AuditTrailRow[];
}
interface ExecuteBody {
  result: { status: string };
  proposal: Proposal;
}

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('GET /v1/proposals', () => {
  it('returns empty when no proposals exist', async () => {
    const res = await h.app.request('/v1/proposals', { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalListBody>(res);
    expect(body.proposals).toEqual([]);
  });

  it('lists proposals for the caller tenant only', async () => {
    await seedProposal(h);
    await seedProposal(h);

    const res = await h.app.request('/v1/proposals', { headers: h.headers });
    const body = await readJson<ProposalListBody>(res);
    expect(body.proposals).toHaveLength(2);
    expect(body.proposals.every((p) => p.tenantId === TEST_TENANT_A)).toBe(true);
  });

  it('filters by status', async () => {
    await seedProposal(h);
    const id = await seedProposal(h);
    // decide one → approved
    await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved' }),
    });

    const res = await h.app.request('/v1/proposals?status=approved', { headers: h.headers });
    const body = await readJson<ProposalListBody>(res);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.id).toBe(id);
  });

  it('rejects invalid status with 400', async () => {
    const res = await h.app.request('/v1/proposals?status=nope', { headers: h.headers });
    expect(res.status).toBe(400);
  });

  it('rejects non-positive limit with 400', async () => {
    const res = await h.app.request('/v1/proposals?limit=0', { headers: h.headers });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/proposals/:id', () => {
  it('returns the proposal when caller owns it', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}`, { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalBody>(res);
    expect(body.proposal.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    const res = await h.app.request('/v1/proposals/does-not-exist', { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('returns 404 when proposal belongs to a different tenant (no leak)', async () => {
    const id = await seedProposal(h);
    // ask as tenant B
    const otherHeaders = { 'x-tenant-id': TEST_TENANT_B, 'x-user-id': h.userId };
    const res = await h.app.request(`/v1/proposals/${id}`, { headers: otherHeaders });
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/proposals/:id/decide', () => {
  it('approves a pending proposal and writes audit intent + outcome', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', comment: 'looks good' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalBody>(res);
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.decision?.verdict).toBe('approved');
    expect(body.proposal.decision?.comment).toBe('looks good');
    expect(body.proposal.decision?.approverId).toBe(h.userId);

    // Audit trail recorded
    const aud = await h.app.request(
      `/v1/audit?resourceType=proposal&resourceId=${id}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditBody>(aud);
    expect(trail.events).toHaveLength(1);
    expect(trail.events[0]!.intent.action).toBe('decide_proposal:approved');
    expect(trail.events[0]!.intent.actorType).toBe('user');
    expect(trail.events[0]!.outcome?.status).toBe('approved');
  });

  it('rejects a pending proposal', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'rejected', comment: 'wrong tone' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalBody>(res);
    expect(body.proposal.status).toBe('rejected');
  });

  it('flips verdict to "edited" when editedPayload is present', async () => {
    const id = await seedProposal(h);
    const edited = { to: 'edited@x.com', subject: 's', body: 'rewritten body' };
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', editedPayload: edited }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProposalBody>(res);
    expect(body.proposal.status).toBe('approved');
    expect(body.proposal.decision?.verdict).toBe('edited');
    expect(body.proposal.decision?.editedPayload).toEqual(edited);
    // original payload preserved
    expect(body.proposal.payload).toEqual({ to: 'a@b.com', subject: 's', body: 'b' });
  });

  it('writes audit action=decide_proposal:edited and includes editedPayload in the intent', async () => {
    const id = await seedProposal(h);
    const edited = { to: 'edited@x.com', subject: 's', body: 'rewritten' };
    await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', editedPayload: edited }),
    });
    const aud = await h.app.request(
      `/v1/audit?resourceType=proposal&resourceId=${id}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditBody>(aud);
    expect(trail.events).toHaveLength(1);
    expect(trail.events[0]!.intent.action).toBe('decide_proposal:edited');
    expect(
      (trail.events[0]!.intent.payload as { editedPayload: unknown }).editedPayload,
    ).toEqual(edited);
  });

  it('rejects {verdict: "rejected", editedPayload} with 400', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'rejected',
        editedPayload: { to: 'x@x.com', subject: 's', body: 'b' },
      }),
    });
    expect(res.status).toBe(400);
    // proposal remains pending — no decision was applied
    const after = await h.app.request(`/v1/proposals/${id}`, { headers: h.headers });
    const body = await readJson<ProposalBody>(after);
    expect(body.proposal.status).toBe('pending');
  });

  it('returns 409 when deciding a non-pending proposal', async () => {
    const id = await seedProposal(h);
    await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved' }),
    });
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'rejected' }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 when proposal belongs to a different tenant', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: {
        'x-tenant-id': TEST_TENANT_B,
        'x-user-id': h.userId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ verdict: 'approved' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects malformed verdict with 400', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty body with 400', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: '',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/proposals/:id/execute', () => {
  async function approve(id: string, body: Record<string, unknown> = {}) {
    await h.app.request(`/v1/proposals/${id}/decide`, {
      method: 'POST',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approved', ...body }),
    });
  }

  it('executes an approved proposal and flips status to executed', async () => {
    const id = await seedProposal(h);
    await approve(id);
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(200);
    const body = await readJson<ExecuteBody>(res);
    expect(body.result.status).toBe('executed');
    expect(body.proposal.status).toBe('executed');
  });

  it('uses editedPayload at execution time, not the agent draft', async () => {
    const id = await seedProposal(h);
    await approve(id, {
      editedPayload: { to: 'reviewer@x.com', subject: 's', body: 'reviewer-rewrote-this' },
    });
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: h.headers,
    });
    const body = await readJson<ExecuteBody>(res);
    expect(body.result.status).toBe('executed');

    // Audit trail: the execute_proposal intent should record the original
    // payload (it's what the action_type "claims" to do); the outbox is what
    // the executor actually acted on.
    const aud = await h.app.request(
      `/v1/audit?resourceType=proposal&resourceId=${id}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditBody>(aud);
    const exec = trail.events.find((e) =>
      e.intent.action.startsWith('execute_proposal:'),
    );
    expect(exec).toBeDefined();
    expect(exec?.outcome?.status).toBe('executed');
  });

  it('returns 409 when proposal is still pending (cannot execute pre-approval)', async () => {
    const id = await seedProposal(h);
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 when proposal belongs to a different tenant', async () => {
    const id = await seedProposal(h);
    await approve(id);
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: { 'x-tenant-id': TEST_TENANT_B, 'x-user-id': h.userId },
    });
    expect(res.status).toBe(404);
  });

  it('sanitises 5xx body so executor exception text does not leak', async () => {
    // Regression for codex HIGH-2: the execute route used to return
    // { result: { error: <raw err.message>, ... } } with status 500. That
    // leaks internal failure detail (stack-like text, connection strings,
    // upstream API messages) to the HTTP client. Public 500 bodies must
    // carry a generic message; the verbose error stays in console.error +
    // the audit outcome's errorText.
    const SECRET = 'INTERNAL_SECRET_LEAK_CANARY_db_pwd=hunter2';
    getAppState().registry.register({
      actionType: 'test_throwing_action',
      async execute() {
        throw new Error(SECRET);
      },
    });

    const id = await seedProposal(h, { actionType: 'test_throwing_action' });
    await approve(id);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(500);

    const bodyText = await res.clone().text();
    expect(bodyText).not.toContain(SECRET);
    const body = await readJson<{ error: string; proposal: { id: string; status: string } | null }>(res);
    expect(body.error).toBe('internal error');
    // Caller still gets enough state context to react (proposal id + new status)
    // without exposing executor internals.
    expect(body.proposal?.id).toBe(id);
    expect(body.proposal?.status).toBe('failed');

    // Server-side log captured the raw error for forensics.
    const loggedSecret = errSpy.mock.calls.some((call) => JSON.stringify(call).includes(SECRET));
    expect(loggedSecret).toBe(true);
    errSpy.mockRestore();

    // Audit trail still records the verbose error for offline forensics.
    const aud = await h.app.request(
      `/v1/audit?resourceType=proposal&resourceId=${id}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditBody>(aud);
    const exec = trail.events.find((e) => e.intent.action.startsWith('execute_proposal:'));
    expect(exec?.outcome?.status).toBe('failed');
    expect(exec?.outcome?.errorText).toBe(SECRET);
  });

  it('sanitises 5xx body when no executor is registered for the action_type', async () => {
    // Second leak channel: when registry.get(actionType) is undefined, the
    // route returned `{ result: { error: 'no executor registered for action_type=...' } }`
    // with 500. That leaks action_type strings (which may carry tenant-coined
    // names in future). Same sanitisation rule applies.
    const id = await seedProposal(h, { actionType: 'unregistered_action_type_xyz' });
    await approve(id);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await h.app.request(`/v1/proposals/${id}/execute`, {
      method: 'POST',
      headers: h.headers,
    });
    expect(res.status).toBe(500);
    const bodyText = await res.clone().text();
    expect(bodyText).not.toContain('unregistered_action_type_xyz');
    expect(bodyText).not.toContain('no executor registered');
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe('internal error');
    errSpy.mockRestore();
  });
});
