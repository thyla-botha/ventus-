import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';

// SERVICE-ROLE access. Bypasses RLS.
//
// This file is the ONLY place in the codebase allowed to import the service
// role key. CI enforces this via scripts/lint-tenancy.mjs. Every export here
// must be reviewed at change time. Do not re-export the raw client.
//
// Legitimate uses:
//   - Tenant provisioning (creating the tenants row before any tenant context exists)
//   - Background tasks that must touch multiple tenants (e.g. global cost rollups)
//   - Migrations and admin tooling
//
// Forbidden:
//   - Any per-request handler in apps/api or apps/web
//   - Any agent tool call
//   - Any worker job that operates on a single tenant — use withTenant() instead

let adminClient: SupabaseClient | null = null;
let adminPool: postgres.Sql | null = null;

function getAdminSupabase(): SupabaseClient {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  }
  adminClient = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

function getAdminPool(): postgres.Sql {
  if (adminPool) return adminPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  adminPool = postgres(url, { max: 4, prepare: false });
  return adminPool;
}

export async function createTenant(input: {
  name: string;
  slug: string;
  plan?: 'pilot' | 'growth' | 'scale' | 'enterprise';
}): Promise<{ id: string }> {
  const sql = getAdminPool();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tenants (name, slug, plan)
    VALUES (${input.name}, ${input.slug}, ${input.plan ?? 'pilot'})
    RETURNING id
  `;
  if (!rows[0]) throw new Error('failed to create tenant');
  return rows[0];
}

export async function setTenantAgentsEnabled(tenantId: string, enabled: boolean): Promise<void> {
  const sql = getAdminPool();
  await sql`
    UPDATE tenants
    SET agents_enabled = ${enabled}, updated_at = now()
    WHERE id = ${tenantId}
  `;
}

export function _internalAdminSupabase(): SupabaseClient {
  // Escape hatch. Tag every callsite with a code comment explaining why it
  // cannot use withTenant(). CI flags new callers of this function.
  return getAdminSupabase();
}
