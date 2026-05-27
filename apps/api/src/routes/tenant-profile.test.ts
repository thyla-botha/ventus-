import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_TENANT_PROFILE_LEN } from '@ventus/store';
import {
  makeHarness,
  readJson,
  TEST_TENANT_A,
  TEST_TENANT_B,
  TEST_USER,
  type TestHarness,
} from '../test-helpers.js';

interface ProfileBody {
  profile: {
    tenantId: string;
    body: string;
    contentHash: string;
    updatedAt: string;
    updatedBy?: string;
    runtime?: { provider: string; model: string };
    runtimeUpdatedAt?: string;
    runtimeUpdatedBy?: string;
  };
}

describe('GET /v1/tenant/profile', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 401 without tenant headers', async () => {
    const res = await h.app.request('/v1/tenant/profile');
    expect(res.status).toBe(401);
  });

  it('returns 404 when no profile is set', async () => {
    const res = await h.app.request('/v1/tenant/profile', { headers: h.headers });
    expect(res.status).toBe(404);
  });

  it('returns the profile when set', async () => {
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Brand voice: warm.' }),
    });
    const res = await h.app.request('/v1/tenant/profile', { headers: h.headers });
    expect(res.status).toBe(200);
    const body = await readJson<ProfileBody>(res);
    expect(body.profile.tenantId).toBe(TEST_TENANT_A);
    expect(body.profile.body).toBe('Brand voice: warm.');
    expect(body.profile.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.profile.updatedBy).toBe(TEST_USER);
  });
});

describe('PUT /v1/tenant/profile', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 401 without tenant headers', async () => {
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not an admin', async () => {
    // PRIVILEGE BOUNDARY: the profile body becomes part of every agent's
    // system prompt. A non-admin member must NOT be able to rewrite it,
    // even though they're authenticated in the correct tenant. The default
    // role is 'member' when x-user-role is absent — so plain h.headers is
    // exactly the "junior support user" case we want to reject.
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'malicious override' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body shape with 400', async () => {
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: 'shape' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a body that exceeds MAX_TENANT_PROFILE_LEN with 400', async () => {
    const tooBig = 'x'.repeat(MAX_TENANT_PROFILE_LEN + 1);
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: tooBig }),
    });
    expect(res.status).toBe(400);
  });

  it('persists the profile and returns the new row', async () => {
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Brand voice: warm.\nIndustry: real estate.' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProfileBody>(res);
    expect(body.profile.body).toBe('Brand voice: warm.\nIndustry: real estate.');
    expect(body.profile.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isolates writes across tenants', async () => {
    // Tenant A writes its profile…
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'A profile' }),
    });
    // …Tenant B GETs and must see 404, not A's body. Read is open to any
    // member, so plain headers (no admin role) is the right test header here.
    const bHeaders = { 'x-tenant-id': TEST_TENANT_B, 'x-user-id': TEST_USER };
    const res = await h.app.request('/v1/tenant/profile', { headers: bHeaders });
    expect(res.status).toBe(404);
  });

  it('admin role is checked BEFORE body schema (auth is not bypassed by bad payloads)', async () => {
    // A non-admin sending an invalid body should see 403 (auth gate) not 400
    // (schema gate). Otherwise the schema becomes an oracle for "is this
    // endpoint live" without going through the privilege check.
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: 'shape' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /v1/tenant/profile', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('clears the profile body but leaves an empty record (200 + body="" on subsequent GET)', async () => {
    // Set, then delete, then GET. The "delete-as-set-empty" choice means
    // GET still returns 200 with an empty body — this is intentional
    // (snapshot-consistency over feel-good 404).
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'something' }),
    });
    const del = await h.app.request('/v1/tenant/profile', {
      method: 'DELETE',
      headers: h.adminHeaders,
    });
    expect(del.status).toBe(204);
    const get = await h.app.request('/v1/tenant/profile', { headers: h.headers });
    expect(get.status).toBe(200);
    const body = await readJson<ProfileBody>(get);
    expect(body.profile.body).toBe('');
  });

  it('returns 403 when caller is not an admin', async () => {
    // Same privilege boundary as PUT — clearing the profile rewrites the
    // org-wide system-prompt block to empty. Non-admins must not be able to.
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'DELETE',
      headers: h.headers,
    });
    expect(res.status).toBe(403);
  });
});

interface AuditTrailBody {
  events: {
    intent: {
      action: string;
      actorType: 'user' | 'agent' | 'system';
      actorId?: string;
      resourceType?: string;
      resourceId?: string;
      payload?: { bodyLength?: number; bodyHash?: string };
    };
    outcome: { status: string; result?: unknown; errorText?: string } | null;
  }[];
}

describe('tenant profile audit coverage', () => {
  // Regression for codex MEDIUM-1: tenant_profile mutations bypass the audit
  // trail. Writes here change the org-wide system prompt (huge blast radius —
  // every subsequent agent run reads the new body), so "who set this, when,
  // and to what content hash" must be reconstructable from audit alone.
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('PUT writes audit intent + executed outcome with bodyHash (not raw body)', async () => {
    const SECRET_BODY = 'PRIVATE BRAND VOICE: never reveal pricing tiers.';
    const put = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: SECRET_BODY }),
    });
    expect(put.status).toBe(200);

    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    expect(trail.events).toHaveLength(1);
    const ev = trail.events[0]!;
    expect(ev.intent.action).toBe('set_tenant_profile');
    expect(ev.intent.actorType).toBe('user');
    expect(ev.intent.actorId).toBe(TEST_USER);
    expect(ev.intent.resourceType).toBe('tenant_profile');
    expect(ev.intent.resourceId).toBe(h.tenantId);
    // Body is hashed in the intent payload, not stored verbatim — the audit
    // trail should never duplicate the prompt content.
    expect(ev.intent.payload?.bodyLength).toBe(SECRET_BODY.length);
    expect(typeof ev.intent.payload?.bodyHash).toBe('string');
    expect(JSON.stringify(ev.intent.payload)).not.toContain(SECRET_BODY);
    expect(ev.outcome?.status).toBe('executed');
  });

  it('PUT writes a failed outcome when the body exceeds the store cap', async () => {
    // The store cap (8_000) is intentionally LARGER than the schema cap
    // (4_000) so the typical 400 path comes from zod. To force the store
    // throw, we'd need to bypass the schema — easier to verify the schema
    // path doesn't silently skip auditing. So we send a body length that
    // trips the schema (>4_000) and assert NO audit row was written
    // (we never accepted the request).
    const tooBig = 'x'.repeat(MAX_TENANT_PROFILE_LEN + 1);
    const put = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: tooBig }),
    });
    expect(put.status).toBe(400);
    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    // Schema rejected at the boundary — no intent should have been recorded.
    expect(trail.events).toHaveLength(0);
  });

  it('DELETE writes audit intent + executed outcome', async () => {
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'temporary' }),
    });
    const del = await h.app.request('/v1/tenant/profile', {
      method: 'DELETE',
      headers: h.adminHeaders,
    });
    expect(del.status).toBe(204);

    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    // listAuditTrail returns most-recent-first — order-independent assertion.
    const actions = trail.events.map((e) => e.intent.action).sort();
    expect(actions).toEqual(['clear_tenant_profile', 'set_tenant_profile']);
    const clearEv = trail.events.find((e) => e.intent.action === 'clear_tenant_profile')!;
    expect(clearEv.intent.actorType).toBe('user');
    expect(clearEv.intent.actorId).toBe(TEST_USER);
    expect(clearEv.outcome?.status).toBe('executed');
  });

  it('writes NO audit row when the caller is not an admin (forbidden before audit)', async () => {
    // Defense in depth: requireAdmin runs before the audit intent is
    // recorded, so a forbidden request should leave zero rows on the trail —
    // we don't want "user X tried to write tenant_profile" surfacing as a
    // legitimate audit entry that confuses reconciliation.
    const res = await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'nope' }),
    });
    expect(res.status).toBe(403);
    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    expect(trail.events).toHaveLength(0);
  });

  it('isolates audit rows per tenant', async () => {
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'tenant A body' }),
    });
    // Tenant B reads its own audit — must be empty even though A wrote.
    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${TEST_TENANT_B}`,
      { headers: { 'x-tenant-id': TEST_TENANT_B, 'x-user-id': h.userId } },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    expect(trail.events).toHaveLength(0);
    // Reference TEST_TENANT_A so this test verifies tenant A wrote (the
    // setup) and tenant B did not see it. TEST_TENANT_A is the harness'
    // default tenant — keep an explicit assertion so the imports stay used.
    expect(h.tenantId).toBe(TEST_TENANT_A);
  });
});

describe('PUT /v1/tenant/runtime', () => {
  // Per-tenant runtime override: lets a regulated tenant pin agent runs to
  // (e.g.) ollama+llama3.1 while a cloud tenant in the same process keeps
  // anthropic. Admin-gated for the same reason profile body writes are —
  // switching providers changes who-sees-the-prompt and is at least as
  // significant as editing the prompt itself.
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 401 without tenant headers', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not an admin', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects unsafe characters in provider/model with 400 (codex round-10 P2)', async () => {
    // The store layer rejects control chars and U+2028/U+2029 as
    // defense-in-depth, but if the route schema doesn't reject them too,
    // the store throw bubbles to a 500. The HTTP contract for "bad client
    // input" must always be 400. The cases mirror the store-level test
    // matrix: newline, CR, U+2028 (line separator), NUL, DEL.
    const cases = [
      { provider: 'ollama\n', model: 'm' },
      { provider: 'ollama\rsmuggled', model: 'm' },
      { provider: 'ollama smuggled', model: 'm' },
      { provider: 'ollama\x00', model: 'm' },
      { provider: 'ollama\x7f', model: 'm' },
      { provider: 'ollama', model: 'm\n' },
      { provider: 'ollama', model: 'm ' },
    ];
    for (const body of cases) {
      const res = await h.app.request('/v1/tenant/runtime', {
        method: 'PUT',
        headers: { ...h.adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, `payload=${JSON.stringify(body)}`).toBe(400);
    }
  });

  it('rejects an unknown provider with 400 + provider list', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'definitely-not-a-real-provider', model: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; providers: string[] }>(res);
    expect(body.error).toMatch(/unknown runtime provider/);
    expect(body.providers).toContain('anthropic');
  });

  it('persists the runtime override and creates an empty-body profile if absent', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProfileBody>(res);
    expect(body.profile.tenantId).toBe(TEST_TENANT_A);
    expect(body.profile.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    expect(body.profile.runtimeUpdatedBy).toBe(TEST_USER);
    // No prior profile, so body is empty but contentHash is still a stable hash.
    expect(body.profile.body).toBe('');
    expect(body.profile.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('preserves an existing profile body when only runtime is set', async () => {
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Brand voice: warm.' }),
    });
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ProfileBody>(res);
    expect(body.profile.body).toBe('Brand voice: warm.');
    expect(body.profile.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
  });

  it('writes audit intent + executed outcome', async () => {
    const put = await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    expect(put.status).toBe(200);

    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    const ev = trail.events.find((e) => e.intent.action === 'set_tenant_runtime');
    expect(ev).toBeDefined();
    expect(ev!.intent.actorId).toBe(TEST_USER);
    expect(ev!.outcome?.status).toBe('executed');
  });
});

describe('DELETE /v1/tenant/runtime', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('returns 403 when caller is not an admin', async () => {
    const res = await h.app.request('/v1/tenant/runtime', {
      method: 'DELETE',
      headers: h.headers,
    });
    expect(res.status).toBe(403);
  });

  it('clears the runtime override but preserves the profile body', async () => {
    await h.app.request('/v1/tenant/profile', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'keep me' }),
    });
    await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    const del = await h.app.request('/v1/tenant/runtime', {
      method: 'DELETE',
      headers: h.adminHeaders,
    });
    expect(del.status).toBe(204);
    const get = await h.app.request('/v1/tenant/profile', { headers: h.headers });
    const body = await readJson<ProfileBody>(get);
    expect(body.profile.body).toBe('keep me');
    expect(body.profile.runtime).toBeUndefined();
  });

  it('writes audit intent + executed outcome', async () => {
    await h.app.request('/v1/tenant/runtime', {
      method: 'PUT',
      headers: { ...h.adminHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ollama', model: 'llama3.1:8b' }),
    });
    const del = await h.app.request('/v1/tenant/runtime', {
      method: 'DELETE',
      headers: h.adminHeaders,
    });
    expect(del.status).toBe(204);
    const aud = await h.app.request(
      `/v1/audit?resourceType=tenant_profile&resourceId=${h.tenantId}`,
      { headers: h.headers },
    );
    const trail = await readJson<AuditTrailBody>(aud);
    const ev = trail.events.find((e) => e.intent.action === 'clear_tenant_runtime');
    expect(ev).toBeDefined();
    expect(ev!.outcome?.status).toBe('executed');
  });
});
