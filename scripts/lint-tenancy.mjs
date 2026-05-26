#!/usr/bin/env node
// Tenancy lint.
//
// Defense-in-depth against the two most common multi-tenant breach patterns:
//
//   1. Service-role key usage outside packages/db/src/admin.ts.
//      The service role bypasses RLS, so every callsite is a potential
//      cross-tenant leak. We enforce a hard allowlist by file path.
//
//   2. createClient() of Supabase outside packages/db/.
//      Anywhere else risks bypassing the withTenant() wrapper that sets
//      app.tenant_id GUC for RLS to evaluate against.
//
//   3. Raw SQL templates targeting tenant-scoped tables that don't carry a
//      tenant_id predicate. Heuristic — flags the obvious cases.
//
// Run via `pnpm lint:tenancy` from the repo root. Exit 1 on any violation.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TENANT_TABLES = [
  'users','roles','connectors','documents','chunks','entities','edges',
  'memories','agents','runs','proposals','decisions','audit_intents','audit_outcomes',
];

const ALLOWED_ADMIN_IMPORTERS = new Set([
  // Service-role / admin client is allowed only here. Add paths deliberately.
  'packages/db/src/admin.ts',
  'apps/api/src/routes/tenants.ts', // tenant provisioning endpoint (future)
]);

const ALLOWED_SUPABASE_CREATE_CLIENT = new Set([
  'packages/db/src/admin.ts',
  'packages/db/src/client.ts',
]);

const SCAN_DIRS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'build']);
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']);

/** @type {{ file: string, msg: string }[]} */
const violations = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (SCAN_EXTS.has(extname(name))) yield p;
  }
}

function checkFile(absPath) {
  const rel = relative(ROOT, absPath).replace(/\\/g, '/');
  const src = readFileSync(absPath, 'utf8');

  // 1. @ventus/db/admin imports outside allowlist.
  if (/from\s+['"]@ventus\/db\/admin['"]/.test(src) && !ALLOWED_ADMIN_IMPORTERS.has(rel)) {
    violations.push({
      file: rel,
      msg: 'imports @ventus/db/admin but is not in ALLOWED_ADMIN_IMPORTERS',
    });
  }

  // 2. Supabase createClient outside allowlist.
  if (/from\s+['"]@supabase\/supabase-js['"]/.test(src)
      && /\bcreateClient\b/.test(src)
      && !ALLOWED_SUPABASE_CREATE_CLIENT.has(rel)) {
    violations.push({
      file: rel,
      msg: 'createClient() from @supabase/supabase-js outside ALLOWED_SUPABASE_CREATE_CLIENT',
    });
  }

  // 3. Raw SQL heuristic: template literals targeting tenant-scoped tables
  //    without a tenant_id predicate. Skip migration files and the admin file.
  if (rel.startsWith('packages/db/migrations/')) return;
  if (rel === 'packages/db/src/admin.ts') return;

  const sqlBlocks = [...src.matchAll(/sql`([\s\S]*?)`/g)].map((m) => m[1] ?? '');
  for (const block of sqlBlocks) {
    const lower = block.toLowerCase();
    const isMutationOrSelect = /\b(select|insert\s+into|update|delete\s+from)\b/.test(lower);
    if (!isMutationOrSelect) continue;
    const touchesTenantTable = TENANT_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(lower));
    if (!touchesTenantTable) continue;
    const hasTenantPredicate = /\btenant_id\b/.test(lower);
    if (!hasTenantPredicate) {
      violations.push({
        file: rel,
        msg: 'SQL template targets a tenant-scoped table without a tenant_id reference',
      });
    }
  }
}

for (const dir of SCAN_DIRS) {
  try {
    for (const file of walk(join(ROOT, dir))) checkFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

if (violations.length === 0) {
  console.log('lint-tenancy: OK');
  process.exit(0);
}

console.error('lint-tenancy: FAIL\n');
for (const v of violations) console.error(`  ${v.file}: ${v.msg}`);
console.error(`\n${violations.length} violation(s)`);
process.exit(1);
