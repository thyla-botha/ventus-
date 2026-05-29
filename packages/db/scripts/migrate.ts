#!/usr/bin/env tsx
/**
 * Forward-only migration runner.
 *
 * Walks `packages/db/migrations/*.sql` in lexical order and applies each one
 * that hasn't already been recorded in the `_migrations` table. Each
 * migration runs in its own transaction so a half-applied file rolls back
 * cleanly. The runner is idempotent — re-running after a successful pass
 * is a no-op.
 *
 * USAGE
 *   DATABASE_URL=postgres://... pnpm db:migrate
 *
 * The runner is intentionally simple: no down migrations, no parallelism,
 * no checksum drift detection. We expect migrations to be append-only.
 * Editing an already-applied migration is a code review problem, not
 * a runner problem.
 *
 * The runner uses a direct `postgres` connection (NOT withTenant or
 * withAdmin) — these are platform-level DDL operations, not tenant data.
 */

import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
}

function discoverMigrations(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Lexical = numeric for 0000-prefixed names.
  return entries.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

async function ensureMigrationsTable(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function listApplied(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
  return new Set(rows.map((r) => r.name));
}

async function applyMigration(sql: postgres.Sql, m: MigrationFile): Promise<void> {
  // Each migration runs in its own transaction. postgres.js's `unsafe`
  // path is required for multi-statement SQL (the tagged template form
  // assumes one statement per call). The DDL strings come from disk —
  // there's no user input — so unsafe is the right primitive here.
  await sql.begin(async (tx) => {
    await tx.unsafe(m.sql);
    await tx`INSERT INTO _migrations (name) VALUES (${m.name})`;
  });
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error('FATAL: DATABASE_URL not set');
    process.exit(1);
  }
  const sql = postgres(url, { max: 1, prepare: false });
  try {
    await ensureMigrationsTable(sql);
    const applied = await listApplied(sql);
    const all = discoverMigrations();
    const pending = all.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`migrate: nothing to do (${all.length} applied)`);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`migrate: applying ${pending.length} of ${all.length} migrations`);
    for (const m of pending) {
      const start = Date.now();
      try {
        await applyMigration(sql, m);
        // eslint-disable-next-line no-console
        console.log(`  ✓ ${m.name} (${Date.now() - start}ms)`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`  ✗ ${m.name}:`, err instanceof Error ? err.message : err);
        throw err;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`migrate: done (${all.length} applied total)`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('migrate: failed', err);
  process.exit(1);
});
