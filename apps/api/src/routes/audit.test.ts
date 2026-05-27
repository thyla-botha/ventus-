import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditTrailRow } from '@ventus/store';
import {
  makeHarness,
  readJson,
  seedProposal,
  TEST_TENANT_A,
  TEST_TENANT_B,
  type TestHarness,
} from '../test-helpers.js';

interface AuditBody {
  events: AuditTrailRow[];
}

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

describe('GET /v1/audit', () => {
  it('returns empty events when nothing has happened', async () => {
    const res = await h.app.request('/v1/audit', { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<AuditBody>(res);
    expect(body.events).toEqual([]);
  });

  it('returns the joined trail (intent + outcome) for the tenant', async () => {
    const a = await seedProposal(h);
    await decide(a, 'approved');
    const b = await seedProposal(h);
    await decide(b, 'rejected');

    const res = await h.app.request('/v1/audit', { headers: h.headers });
    const body = await readJson<AuditBody>(res);
    expect(body.events).toHaveLength(2);
    for (const e of body.events) {
      expect(e.intent.tenantId).toBe(TEST_TENANT_A);
      expect(e.outcome).not.toBeNull();
    }
  });

  it('filters by resourceType + resourceId', async () => {
    const a = await seedProposal(h);
    const b = await seedProposal(h);
    await decide(a, 'approved');
    await decide(b, 'approved');

    const res = await h.app.request(
      `/v1/audit?resourceType=proposal&resourceId=${a}`,
      { headers: h.headers },
    );
    const body = await readJson<AuditBody>(res);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.intent.resourceId).toBe(a);
  });

  it('filters by runId', async () => {
    const a = await seedProposal(h, { runId: 'run-target' });
    const b = await seedProposal(h, { runId: 'run-other' });
    await decide(a, 'approved');
    await decide(b, 'approved');

    const res = await h.app.request('/v1/audit?runId=run-target', { headers: h.headers });
    const body = await readJson<AuditBody>(res);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]!.intent.runId).toBe('run-target');
  });

  it('enforces tenant isolation — never leaks rows across tenants', async () => {
    const a = await seedProposal(h);
    await decide(a, 'approved');

    const otherHeaders = { 'x-tenant-id': TEST_TENANT_B, 'x-user-id': h.userId };
    const res = await h.app.request('/v1/audit', { headers: otherHeaders });
    const body = await readJson<AuditBody>(res);
    expect(body.events).toEqual([]);
  });

  it('rejects non-positive limit with 400', async () => {
    const res = await h.app.request('/v1/audit?limit=-1', { headers: h.headers });
    expect(res.status).toBe(400);
  });

  it('caps limit at MAX_LIMIT (500) silently', async () => {
    // We can't easily seed >500 rows in a unit test, but we can verify the
    // route doesn't reject limit=999 — it should clamp and 200.
    const res = await h.app.request('/v1/audit?limit=999', { headers: h.headers });
    expect(res.status).toBe(200);
  });

  it('sorts newest first', async () => {
    const a = await seedProposal(h);
    await decide(a, 'approved');
    await new Promise((r) => setTimeout(r, 5));
    const b = await seedProposal(h);
    await decide(b, 'approved');

    const res = await h.app.request('/v1/audit', { headers: h.headers });
    const body = await readJson<AuditBody>(res);
    const proposedAts = body.events.map((e) => e.intent.proposedAt);
    expect([...proposedAts].sort().reverse()).toEqual(proposedAts);
  });
});
