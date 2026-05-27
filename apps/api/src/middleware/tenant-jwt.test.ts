import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetJwtSecretForTests } from './jwt-verify.js';
import {
  makeHarness,
  readJson,
  TEST_TENANT_A,
  TEST_USER,
  type TestHarness,
} from '../test-helpers.js';

// Covers the verified Bearer-token auth path (middleware/jwt-verify.ts +
// tenant.ts) end-to-end against a real Hono request.
//
// Tokens are signed in-test with a known secret so we can exercise valid,
// invalid, expired, and missing-claim cases without standing up a real
// Supabase auth server. The middleware path itself is identical to prod.

const TEST_SECRET = 'test-jwt-secret-do-not-use-in-prod-please';
const ENCODED_SECRET = new TextEncoder().encode(TEST_SECRET);

interface SignOpts {
  sub?: string;
  tenantId?: string;
  userRole?: 'admin' | 'member' | (string & {});
  audience?: string;
  expiresIn?: string;
  noTenantClaim?: boolean;
  noRoleClaim?: boolean;
  secret?: Uint8Array;
}

async function signTestToken(opts: SignOpts = {}): Promise<string> {
  const builder = new SignJWT({
    ...(opts.noTenantClaim ? {} : { tenant_id: opts.tenantId ?? TEST_TENANT_A }),
    ...(opts.noRoleClaim ? {} : { user_role: opts.userRole ?? 'member' }),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub ?? TEST_USER)
    .setAudience(opts.audience ?? 'authenticated')
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m');
  return builder.sign(opts.secret ?? ENCODED_SECRET);
}

let h: TestHarness;
let priorSecret: string | undefined;
let priorDevDefault: string | undefined;

beforeEach(async () => {
  priorSecret = process.env.SUPABASE_JWT_SECRET;
  priorDevDefault = process.env.VENTUS_DEV_DEFAULT_TENANT;
  process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  resetJwtSecretForTests();
  h = await makeHarness();
  // Turn the dev-shim OFF — these tests exercise the JWT-only path. The
  // harness defaults it on for header-using tests; we override.
  delete process.env.VENTUS_DEV_DEFAULT_TENANT;
});

afterEach(async () => {
  await h.cleanup();
  if (priorSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = priorSecret;
  if (priorDevDefault === undefined) delete process.env.VENTUS_DEV_DEFAULT_TENANT;
  else process.env.VENTUS_DEV_DEFAULT_TENANT = priorDevDefault;
  resetJwtSecretForTests();
});

describe('tenantContext — verified Bearer token path', () => {
  it('accepts a valid Bearer token and sets context from claims', async () => {
    const token = await signTestToken();
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects when no Bearer token is provided and dev shim is off', async () => {
    const res = await h.app.request('/v1/proposals');
    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toMatch(/missing Authorization/i);
  });

  it('rejects a malformed Authorization header', async () => {
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: 'Token foo' },
    });
    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toMatch(/malformed/i);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signTestToken({
      secret: new TextEncoder().encode('a-completely-different-secret-of-sufficient-length'),
    });
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await signTestToken({ expiresIn: '-1s' });
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token with aud != "authenticated" (e.g. anon)', async () => {
    const token = await signTestToken({ audience: 'anon' });
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('rejects with 403 when tenant_id custom claim is missing (Supabase hook misconfigured)', async () => {
    const token = await signTestToken({ noTenantClaim: true });
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toMatch(/tenant_id/);
  });

  it('rejects with 403 when user_role custom claim is missing', async () => {
    const token = await signTestToken({ noRoleClaim: true });
    const res = await h.app.request('/v1/proposals', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toMatch(/user_role/);
  });

  it('Bearer claims take precedence over header values (no header smuggling)', async () => {
    // Critical security check: a request that carries BOTH a valid Bearer
    // token AND spoofed x-tenant-id headers must resolve to the Bearer
    // claims. Otherwise an attacker with a valid token for tenant A could
    // pass headers naming tenant B and side-step the gate.
    const token = await signTestToken({ tenantId: TEST_TENANT_A, userRole: 'admin' });
    const spoofTenant = '00000000-0000-0000-0000-00000000000b';
    const res = await h.app.request('/v1/proposals', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': spoofTenant,
        'x-user-id': '00000000-0000-0000-0000-00000000beef',
      },
    });
    expect(res.status).toBe(200);
    // Empty proposals list — confirms we're reading from TEST_TENANT_A
    // (which has no proposals), not the spoofed tenant.
    const body = await readJson<{ proposals: unknown[] }>(res);
    expect(body.proposals).toEqual([]);
  });

  it('rejects a present-but-invalid token even when dev shim is on (no fallthrough)', async () => {
    // A stolen/expired token is NEVER quietly downgraded to header trust.
    // Even with VENTUS_DEV_DEFAULT_TENANT=1, a bad Authorization header
    // returns 401 — not "oh well, try the headers."
    process.env.VENTUS_DEV_DEFAULT_TENANT = '1';
    const token = await signTestToken({ expiresIn: '-1s' });
    const res = await h.app.request('/v1/proposals', {
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant-id': TEST_TENANT_A,
        'x-user-id': TEST_USER,
      },
    });
    expect(res.status).toBe(401);
  });

  it('extracts the admin role from the token (no x-user-role spoofing)', async () => {
    // Admin role MUST come from the verified claim, not a parallel header.
    // We hit the admin-only diagnostic endpoint: a member-role token gets
    // 403, an admin-role token gets 200.
    const memberToken = await signTestToken({ userRole: 'member' });
    const memberRes = await h.app.request('/v1/admin/pricing-coverage', {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(memberRes.status).toBe(403);

    const adminToken = await signTestToken({ userRole: 'admin' });
    const adminRes = await h.app.request('/v1/admin/pricing-coverage', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(adminRes.status).toBe(200);
  });
});
