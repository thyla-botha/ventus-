import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, readJson, seedProposal, type TestHarness } from '../test-helpers.js';

let h: TestHarness;

beforeEach(async () => {
  h = await makeHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe('tenantContext middleware', () => {
  it('returns 401 when x-tenant-id is missing', async () => {
    const res = await h.app.request('/v1/proposals', {
      headers: { 'x-user-id': h.userId },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-user-id is missing', async () => {
    const res = await h.app.request('/v1/proposals', {
      headers: { 'x-tenant-id': h.tenantId },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for malformed UUIDs', async () => {
    const res = await h.app.request('/v1/proposals', {
      headers: { 'x-tenant-id': 'not-a-uuid', 'x-user-id': h.userId },
    });
    expect(res.status).toBe(401);
  });

  it('does NOT apply to /health (middleware scoped to /v1/*)', async () => {
    const res = await h.app.request('/health');
    expect(res.status).toBe(200);
  });

  it('accepts valid headers and proceeds', async () => {
    const res = await h.app.request('/v1/proposals', { headers: h.headers });
    expect(res.status).toBe(200);
  });

  it('normalises tenantId casing so MIXED-case and lowercase resolve to the same tenant', async () => {
    // Regression guard: isUuid() is case-insensitive, but every downstream
    // consumer (file store keys, concurrency-cap Map, tenant filter on
    // GET routes) compares raw strings. If middleware leaves casing as-is,
    // a caller could (a) bypass the per-tenant cap by alternating case
    // and (b) fragment their own data across two store identities.
    //
    // Seed a proposal under the canonical (lowercase) tenant; query with
    // an UPPERCASE tenant header; expect the SAME row back.
    await seedProposal(h);
    const upperTenant = h.tenantId.toUpperCase();
    const res = await h.app.request('/v1/proposals', {
      headers: { 'x-tenant-id': upperTenant, 'x-user-id': h.userId },
    });
    expect(res.status).toBe(200);
    const body = await readJson<{ proposals: { tenantId: string }[] }>(res);
    expect(body.proposals.length).toBe(1);
    // The row's stored tenantId stays as it was written (lowercase); the
    // upper-case header was normalised before the tenant-filter compared.
    expect(body.proposals[0]!.tenantId).toBe(h.tenantId);
  });
});
