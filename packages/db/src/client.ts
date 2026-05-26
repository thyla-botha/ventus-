import postgres from 'postgres';

// Tenant-scoped Postgres client.
//
// Every query goes through a transaction that first SET LOCAL app.tenant_id.
// SET LOCAL is the only safe form under PgBouncer transaction-mode pooling;
// session-level SET leaks across pooled checkouts and is a tenant-isolation hazard.
//
// Use withTenant() for any tenant-scoped work. The admin (service-role) client
// is in ./admin and bypasses RLS by design — every callsite there must be reviewed.

export interface TenantContext {
  tenantId: string;
  userId?: string;
}

export type Db = ReturnType<typeof postgres>;
export type TenantClient = Db;

let pool: Db | null = null;

function getPool(): Db {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  pool = postgres(url, {
    max: 20,
    idle_timeout: 30,
    prepare: false,
  });
  return pool;
}

export async function withTenant<T>(
  ctx: TenantContext,
  fn: (sql: TenantClient) => Promise<T>,
): Promise<T> {
  const sql = getPool();
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`;
    if (ctx.userId) {
      await tx`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    return fn(tx as unknown as TenantClient);
  }) as Promise<T>;
}

export function getTenantClient(): Db {
  return getPool();
}
