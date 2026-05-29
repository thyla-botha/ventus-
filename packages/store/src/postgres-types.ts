// Minimal abstraction over the `postgres` SDK shared by the Postgres-backed
// stores in this package. Re-declared here (instead of imported from
// @ventus/credentials) so @ventus/store stays self-contained — the wiring
// in apps/api passes the same withTenant impl into both packages.

export interface PgRow {
  [key: string]: unknown;
}

export interface PgQuerier {
  <T = PgRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

export interface PgTenantRunner {
  withTenant<T>(
    ctx: { tenantId: string; userId?: string },
    fn: (sql: PgQuerier) => Promise<T>,
  ): Promise<T>;
}

// Extended runner with cross-tenant (RLS-bypassing) access. Required by
// PostgresRunStore + PostgresAuditStore because the RunStore / AuditStore
// interfaces include tenant-less methods (run.get(id), audit.listIntents
// over a known tenant but record-by-intent-id-only updates). The store
// uses withAdmin ONLY to (a) look up which tenant owns a known row id
// before doing the tenant-scoped write, or (b) scan across tenants when
// the caller didn't pass one (the reaper).
//
// Wiring this up to a real connection requires the consumer to import
// @ventus/db's admin pool — that's a service-role privilege boundary and
// the importer MUST be added to scripts/lint-tenancy.mjs's
// ALLOWED_ADMIN_IMPORTERS. apps/api/src/state.ts is on that list because
// it composes the store. This is the same cross-tenant access the reaper
// already documents needing post-Postgres swap.
export interface PgAdminRunner {
  withAdmin<T>(fn: (sql: PgQuerier) => Promise<T>): Promise<T>;
}

export type PgFullRunner = PgTenantRunner & PgAdminRunner;

// Postgres timestamptz comes back as either a Date or a string depending on
// driver config. Normalize to ISO 8601 so callers can compare against other
// ISO strings (matches FileStore contract).
export function normalizeTimestamp(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  return v;
}

// Postgres bigint comes back as a string from postgres.js by default
// (numbers wider than 2^53 would lose precision). Our totalCostMicros /
// proposalCount values fit in JS number, so we coerce when present.
export function normalizeBigint(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}
