import type { Context, MiddlewareHandler } from 'hono';
import { isUuid } from '@ventus/shared';
import { JwtVerifyError, tryVerifyAuthHeader } from './jwt-verify.js';

// Resolves tenant_id + user_id + role from the request and attaches them to
// the context. Two paths, in order:
//
//   1. Authorization: Bearer <jwt>  — production. The JWT is HS256-verified
//      against SUPABASE_JWT_SECRET and tenant_id/user_role custom claims
//      are extracted (see middleware/jwt-verify.ts). This is the only path
//      callers can trust to be tamper-proof.
//
//   2. x-tenant-id / x-user-id / x-user-role headers — dev shim, gated by
//      VENTUS_DEV_DEFAULT_TENANT=1. Lets local development and the existing
//      test suite work without minting tokens. NEVER enable in production:
//      a caller controls these headers, so dev-mode = no authentication.
//
// Boot-time guard (in index.ts): when VENTUS_REQUIRE_VERIFIED_AUTH=1 (or
// when running in NODE_ENV=production), the process refuses to start unless
// SUPABASE_JWT_SECRET is set. That closes the case where a misconfigured
// production deploy quietly falls back to header trust.

export type UserRole = 'admin' | 'member';

const ROLE_VALUES: readonly UserRole[] = ['admin', 'member'];

declare module 'hono' {
  interface ContextVariableMap {
    tenantId: string;
    userId: string;
    userRole: UserRole;
  }
}

const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';

export function tenantContext(): MiddlewareHandler {
  return async (c, next) => {
    // Re-read per request so tests (and future operator-toggle scenarios)
    // can flip the flag without rebuilding the app. The env-lookup cost is
    // negligible against any real request handling.
    const devDefaults = process.env.VENTUS_DEV_DEFAULT_TENANT === '1';
    // Path 1: verified Bearer token.
    try {
      const claims = await tryVerifyAuthHeader(c.req.header('authorization'));
      if (claims) {
        c.set('tenantId', claims.tenantId);
        c.set('userId', claims.userId);
        c.set('userRole', claims.userRole);
        await next();
        return;
      }
    } catch (err) {
      if (err instanceof JwtVerifyError) {
        // A *present-but-invalid* token is never silently downgraded to the
        // header shim. That would let an attacker who has a stolen/expired
        // token slip past the gate by adding header values alongside it.
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }

    // Path 2: dev shim. Only when explicitly enabled.
    if (!devDefaults) {
      return c.json(
        { error: 'missing Authorization: Bearer token' },
        401,
      );
    }

    let tenantId = c.req.header('x-tenant-id') ?? '';
    let userId = c.req.header('x-user-id') ?? '';

    if (!tenantId) tenantId = DEV_TENANT_ID;
    if (!userId) userId = DEV_USER_ID;

    if (!isUuid(tenantId) || !isUuid(userId)) {
      return c.json({ error: 'missing or invalid tenant/user context' }, 401);
    }

    // CRITICAL: normalise to lowercase canonical form (RFC 4122) BEFORE
    // setting on context. isUuid() accepts mixed case, but every downstream
    // consumer — the concurrency-cap Map, file-store row reads, tenant
    // filter on GET handlers — compares as raw strings. Without
    // normalisation, "...000a" and "...000A" become two separate tenant
    // identities: a caller could bypass the per-tenant cap by alternating
    // casing, and a tenant that sometimes sent lowercase + sometimes upper
    // would see "their own" data fragmented across two stores.
    tenantId = tenantId.toLowerCase();
    userId = userId.toLowerCase();

    const roleHeader = c.req.header('x-user-role');
    const userRole: UserRole =
      roleHeader && (ROLE_VALUES as readonly string[]).includes(roleHeader)
        ? (roleHeader as UserRole)
        : 'member';

    c.set('tenantId', tenantId);
    c.set('userId', userId);
    c.set('userRole', userRole);
    await next();
  };
}

// Route-level guard: returns 403 unless the request's resolved role is
// 'admin'. Use on writes that mutate platform-level config a regular
// tenant member should NOT be able to edit (tenant_profile body, future
// skills upload, etc.). Reads do NOT typically require this — admins
// gate writes, not visibility.
export function requireAdmin(c: Context): Response | null {
  if (c.var.userRole !== 'admin') {
    return c.json({ error: 'admin role required' }, 403);
  }
  return null;
}
