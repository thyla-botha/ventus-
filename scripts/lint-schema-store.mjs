#!/usr/bin/env node
// Schema ↔ store drift lint.
//
// Catches the silent failure mode: someone adds a column to a migration but
// forgets the corresponding TypeScript type. The bug looks like nothing in
// development (the file store doesn't enforce the schema) but blows up at
// Postgres swap time as a runtime "column not found" or, worse, a quietly
// dropped field that should have been persisted.
//
// Heuristic:
//   1. Walk packages/db/migrations/*.sql
//   2. Collect every column referenced in `CREATE TABLE` and `ADD COLUMN`
//   3. Convert snake_case → camelCase
//   4. Grep the TS codebase for each camelCase identifier
//   5. Fail if any are missing (modulo the IGNORED set — infra columns that
//      legitimately have no TS-layer representation)
//
// This is a heuristic. False positives go in IGNORED. False negatives (TS
// types that drift from the schema by being deleted/renamed) need typecheck
// at the database adapter layer — that's a separate problem.
//
// Run via `node scripts/lint-schema-store.mjs` from the repo root.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const MIGRATIONS_DIR = join(ROOT, 'packages/db/migrations');

// Tables we expect to have TS-layer types. Other tables (auth scaffolding,
// junction tables, vector index helpers) don't need to appear in the store
// types and shouldn't be checked.
//
// Add to this set when adding a new table that should be mirrored in TS.
const CHECKED_TABLES = new Set([
  'runs',
  'proposals',
  'audit_intents',
  'audit_outcomes',
  'tenant_profiles',
]);

// Columns we deliberately omit from TS types. These are either:
//   - infra (id, tenant_id, timestamps) handled implicitly by the adapter
//   - server-only fields that the application layer never reads
// Add deliberately, with a comment explaining why.
const IGNORED_COLUMNS = new Set([
  'id', // primary key — always present in TS as `id`
  'tenant_id', // tenancy column — always `tenantId` (covered by separate check)
  'created_at', // creation timestamp — sometimes surfaced as startedAt etc.
  'updated_at', // mutation timestamp — sometimes derived from other fields
]);

// Pre-existing drift. Columns that appear in early migrations but were
// never surfaced in the TS file-store types (the file store models a
// simplified view of the real schema). This is BASELINE drift — these
// rows will be reconciled when we adopt Postgres + a typed adapter,
// not now. The lint still fires on any NEW drift introduced after this
// baseline.
//
// Add to this list ONLY when you've checked the column is intentionally
// not modelled in the file-store types (e.g. server-only audit fields).
// Remove an entry when you DO add the field to the TS layer — the lint
// will then enforce that it stays.
//
// Tracked as a deferred backlog item ("file-store vs Postgres drift").
const KNOWN_DRIFT = new Set([
  // 0001_initial.sql:runs — file store models only the columns the agent
  // loop reads/writes; trigger/trace_id/metadata/tokens/cost are server-side
  // accounting fields that will land when the Postgres adapter does.
  'runs.trigger',
  'runs.trace_id',
  // 0002_audit.sql:audit_intents — user_agent is captured for forensics
  // by the future HTTP-layer ingest, not by the agent runtime.
  'audit_intents.user_agent',
]);

// Where to search for camelCase column references. We scan TS source under
// packages/store and apps/* (any layer that reads/writes the row).
const SEARCH_DIRS = ['packages/store/src', 'apps'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.turbo', 'dist', 'build']);
const SEARCH_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function snakeToCamel(snake) {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walk(p);
    else if (SEARCH_EXTS.has(extname(name))) yield p;
  }
}

// Parse migration files for column declarations. Returns Map<table, Set<column>>.
//
// We handle two patterns:
//   1. CREATE TABLE <name> ( <col_name> <type> ..., <col_name> <type> ... )
//   2. ALTER TABLE <name> ADD COLUMN <col_name> <type> ...
//
// SQL parsing is best-effort. Comments are stripped; we look for column names
// in the simple form `<word> <type-keyword>`. Complex column constraints
// (CHECK, DEFAULT expressions) don't break us because we anchor on
// well-known type tokens at the start of the column spec.
const TYPE_TOKENS = [
  'uuid', 'text', 'timestamptz', 'timestamp', 'jsonb', 'json',
  'boolean', 'integer', 'int', 'bigint', 'smallint', 'numeric', 'decimal',
  'vector', 'tsvector', 'bytea', 'serial', 'bigserial', 'date', 'time',
];
const TYPE_RE = new RegExp(`^\\s*([a-z_][a-z0-9_]*)\\s+(${TYPE_TOKENS.join('|')})\\b`, 'i');

function stripSqlComments(src) {
  return src
    .replace(/--[^\n]*/g, '') // -- line comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // /* block comments */
}

function parseColumns(migrationSrc) {
  const out = new Map();
  const src = stripSqlComments(migrationSrc);

  // CREATE TABLE blocks. Capture table name + the parenthesised column list.
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi;
  for (const m of src.matchAll(createRe)) {
    const table = m[1].toLowerCase();
    const body = m[2];
    // Split by commas at the top paren level. Naive but enough for our
    // migrations — we don't use nested parens in column declarations
    // beyond CHECK/REFERENCES, both of which keep their commas inside.
    const cols = splitTopLevel(body);
    for (const raw of cols) {
      const tm = raw.match(TYPE_RE);
      if (!tm) continue; // skip constraints (UNIQUE, PRIMARY KEY, etc.)
      const name = tm[1].toLowerCase();
      if (!out.has(table)) out.set(table, new Set());
      out.get(table).add(name);
    }
  }

  // ALTER TABLE ... ADD COLUMN. One per match.
  const alterRe = /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)[\s\S]*?ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi;
  for (const m of src.matchAll(alterRe)) {
    const table = m[1].toLowerCase();
    const col = m[2].toLowerCase();
    if (!out.has(table)) out.set(table, new Set());
    out.get(table).add(col);
  }

  return out;
}

// Split a parenthesised column list by commas at depth 0. Handles nested
// parens in REFERENCES(...) and CHECK(...) without breaking on their commas.
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// ---- 1. Collect expected columns from migrations
const expected = new Map(); // table -> Set<column>
const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
for (const f of migrationFiles) {
  const src = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
  const parsed = parseColumns(src);
  for (const [table, cols] of parsed) {
    if (!expected.has(table)) expected.set(table, new Set());
    for (const c of cols) expected.get(table).add(c);
  }
}

// ---- 2. Build the search corpus once
const corpus = [];
for (const dir of SEARCH_DIRS) {
  try {
    for (const file of walk(join(ROOT, dir))) {
      corpus.push({ rel: relative(ROOT, file).replace(/\\/g, '/'), src: readFileSync(file, 'utf8') });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function corpusHas(identifier) {
  // Match word-boundary so `userId` doesn't satisfy `id`. We also want to
  // catch quoted form (e.g. JSON.stringify key as 'userId'), which the
  // \b regex handles.
  const re = new RegExp(`\\b${identifier}\\b`);
  return corpus.some((f) => re.test(f.src));
}

// ---- 3. Diff
const missing = [];
for (const [table, cols] of expected) {
  if (!CHECKED_TABLES.has(table)) continue;
  for (const col of cols) {
    if (IGNORED_COLUMNS.has(col)) continue;
    if (KNOWN_DRIFT.has(`${table}.${col}`)) continue;
    const camel = snakeToCamel(col);
    if (!corpusHas(camel)) {
      missing.push({ table, col, camel });
    }
  }
}

if (missing.length === 0) {
  console.log('lint-schema-store: OK');
  process.exit(0);
}

console.error('lint-schema-store: FAIL\n');
console.error('Columns declared in packages/db/migrations/*.sql but not referenced');
console.error('anywhere in packages/store/src or apps/. Either:');
console.error('  (a) add the field to the corresponding TS type, or');
console.error('  (b) add the column name to IGNORED_COLUMNS in this script with a comment.\n');
for (const m of missing) {
  console.error(`  ${m.table}.${m.col}  (expected TS: ${m.camel})`);
}
console.error(`\n${missing.length} missing column reference(s)`);
process.exit(1);
