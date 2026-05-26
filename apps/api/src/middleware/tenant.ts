import type { Context, MiddlewareHandler } from 'hono';
import { isUuid } from '@ventus/shared';

// Resolves tenant_id from request headers and attaches it to the request.
// Downstream handlers MUST go through withTenant() for any DB access.
//
// Auth wiring is intentionally absent at this scaffold stage. Wire Supabase
// Auth JWT verification + custom claim extraction here in Phase 1.
//
// Dev escape hatch: when VENTUS_DEV_DEFAULT_TENANT=1, missing headers fall
// back to the zero-UUID tenant and a "dev-user" placeholder. Never enable
// this in any environment that handles real customer data.

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
  const devDefaults = process.env.VENTUS_DEV_DEFAULT_TENANT === '1';
  return async (c, next) => {
    let tenantId = c.req.header('x-tenant-id') ?? '';
    let userId = c.req.header('x-user-id') ?? '';

    if (devDefaults) {
      if (!tenantId) tenantId = DEV_TENANT_ID;
      if (!userId) userId = DEV_USER_ID;
    }

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

    // Role is header-derived for now (same dev shim as tenant/user). When real
    // auth lands, this MUST come from verified session claims, not a header
    // the caller controls. Default 'member' fails CLOSED for admin-gated
    // routes — callers must explicitly assert 'admin' to write privileged
    // resources like tenant_profile.
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
