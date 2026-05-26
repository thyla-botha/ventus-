# Ventus

Multi-tenant agentic operations platform. Ingests business systems (Gmail,
Drive, Slack, Jira, ClickUp, WhatsApp), builds queryable memory, and runs
tiered agents with audit and approval gates.

Status: scaffold. Phase 0 of the build.

## Layout

```
apps/
  web/            Next.js 15 frontend
  api/            Hono HTTP API
  worker/         BullMQ job workers
  mcp-gateway/    Per-tenant credential + tool-call proxy (HIGH BLAST RADIUS)
  agent-runtime/  Vendor-agnostic agent execution
packages/
  db/             Postgres client + service-role admin (RLS bypass) + types
  shared/         Shared types and errors
  audit/          Two-phase audit log writer (intent + outcome)
scripts/
  lint-tenancy.mjs   CI lint: enforces tenant isolation discipline
packages/db/migrations/
  0001_initial.sql   Core schema
  0002_audit.sql     Two-phase audit log + append-only triggers
  0003_rls.sql       Row-level security policies
```

## Prereqs

- Node 22+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Docker (for local Postgres + Redis)

## Bootstrap

```bash
# 1. Install deps
pnpm install

# 2. Start Postgres (pgvector) + Redis
docker compose up -d

# 3. Migrations are auto-applied on first Postgres start via
#    docker-entrypoint-initdb.d. For re-runs:
#    docker compose down -v && docker compose up -d

# 4. Copy env template
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY, generate ENCRYPTION_KEY, etc.

# 5. Run everything in dev
pnpm dev
```

Per-app dev:

```bash
pnpm --filter @ventus/api dev
pnpm --filter @ventus/web dev
pnpm --filter @ventus/worker dev
```

## Multi-tenant discipline (read this before writing any DB code)

Every tenant-scoped table has RLS enabled. RLS evaluates against
`app.tenant_id`, a Postgres GUC set per transaction.

**Rule 1.** Use `withTenant({ tenantId, userId? }, async (sql) => { ... })`
from `@ventus/db` for all tenant-scoped DB work. It sets `app.tenant_id`
inside a transaction via `SET LOCAL`, which is the only safe form under
PgBouncer transaction-mode pooling.

**Rule 2.** The service-role key bypasses RLS. It lives only in
`packages/db/src/admin.ts`. Importing `@ventus/db/admin` outside that file
is blocked by `scripts/lint-tenancy.mjs`. Add allowlist entries deliberately.

**Rule 3.** Background workers must extract `tenantId` from the job payload
and pass it through `withTenant()`. No raw service-role queries in workers.

**Rule 4.** Two-phase audit. Every action calls `withAudit()` from
`@ventus/audit`, which writes an `audit_intents` row before the action and
an `audit_outcomes` row after. Joining them is the regulator-defensible
record. Single-phase writes (action claimed but never executed) are not
permitted.

## Open architectural decisions

- **MCP gateway build-vs-buy** — current scaffold is in-house. Evaluation
  of Pomerium / Cloudflare AI Gateway alternatives pending. Do not invest
  in the credential vault or PII scrubber until this decision is made.
- **Memory layer** — Mem0 vs Zep/Graphiti. Default abstraction shape lives
  in `@ventus/shared` (TBD).
- **Reranker** — Cohere rerank-3 (paid) vs bge-reranker-v2 (self-hosted GPU).
  Decide when retrieval quality is being tuned, not before.

## What's NOT scaffolded yet

- OAuth flows for each connector
- Skills registry / loader
- MCP gateway tool-call implementation
- Agent runtime tool loop
- Approval inbox UI
- Cost ceiling enforcement
- Killswitch wiring at the gateway

All deferred to the next build sessions per the 36-week baseline.
