# Ventus — project instructions

Multi-tenant agentic operations platform for regulated mid-market businesses.
Target verticals: real estate (#1), forex brokers (#2). Tier 2 = draft → human approves → execute, with full audit traceability.

These rules apply to every chunk of work. They are NOT suggestions; they exist because previous bugs / incidents required them.

---

## First action of every session

1. Read `MEMORY.md` (project context, deferred backlog, architecture decisions).
2. Read this file (the rules below).
3. If git hooks are not installed in this clone: `bash scripts/install-hooks.sh`.

---

## The feature checklist

EVERY new feature, refactor, or bugfix must answer these before being called done. Answer them explicitly in the response when the work lands — don't just claim "all good."

1. **Audit-before-execute** — does the action write an audit_log row BEFORE the side effect? If the executor commits but the audit row is missing, that's a P0. Orphan-on-success-path is the invariant.
2. **Tenant from middleware only** — does the code use `c.var.tenantId`, never a body-supplied id? If the new code calls a store with a tenant param, the value MUST originate from the request context.
3. **`lint-tenancy` is clean** — `node scripts/lint-tenancy.mjs` exits 0. New admin-import paths (anything that touches `@ventus/db/admin` or bypasses RLS) MUST be added to `ALLOWED_ADMIN_IMPORTERS`.
4. **Tests added** — new behaviour has at least one test. Race conditions deserve their own test (loop-vs-reaper, claim-vs-release, list-vs-complete). Edge cases (no row, terminal row, concurrent calls) deserve their own tests.
5. **Typecheck doesn't regress** — `pnpm -r typecheck` doesn't introduce non-TS18046 errors. TS18046 count must NOT grow (baseline 36 — see `scripts/git-hooks/pre-push`).
6. **Secrets / PII handling** — does any new path log OAuth tokens, raw PII, or per-tenant secrets? It must not. Error bodies for 5xx must be generic ("internal error"); log the detail server-side.
7. **Memory updated** — if the work made an architectural decision, captured a new invariant, or shifted the deferred backlog, update `MEMORY.md` and write/update the corresponding memory file.

If any item is "no" or "not applicable," say so explicitly. Silence on a checklist item is read as "I forgot."

---

## Standing invariants

These are non-negotiable. A change that breaks one of these is reverted, not patched over.

- **RLS / tenancy**: when on Postgres, use `app.current_tenant_id()` for RLS policies. Service-role bypass connections live in `ALLOWED_ADMIN_IMPORTERS`.
- **Audit ordering**: audit row written BEFORE the side effect, not after. The audit layer's contract is "if status=executed exists, the side effect committed." Reversed ordering creates ghost audits.
- **OAuth tokens**: encrypted at rest with a **per-tenant key**. Never logged. Never echoed in error bodies.
- **PII**: stripped at the MCP gateway BEFORE the LLM call. The LLM never sees raw PII.
- **Tier policy**: Tier 2 = draft → approve → execute. Tier 3 acts autonomously but only on resources matching a pre-defined policy.
- **Concurrency cap**: per-tenant in-process loop count is bounded by `VENTUS_PER_TENANT_RUN_CAP` (default 5). Don't add new code paths that start loops without going through `tryClaimRunSlot` / `releaseRunSlot`.
- **Heartbeat / reaper**: every step writes a heartbeat. Stuck rows are closed by the reaper. Don't add long-running operations that bypass the per-step heartbeat without telling the user.

---

## Code style

- TypeScript strict, `pnpm` workspaces, `turbo` for cross-package commands.
- Tests: `vitest`. Each route gets its own `*.test.ts`. Use `readJson<T>()` from `apps/api/src/test-helpers.ts` for typed bodies — that's how new tests avoid joining the TS18046 backlog.
- File stores are temporary scaffolding; interfaces are designed to be swapped for Postgres-backed implementations behind the same API.
- Comments: explain WHY, not WHAT. Especially for invariants, races, and accepted-risk decisions.
- Don't add features the task doesn't require. Don't add error handling for impossible cases. Don't add backward-compat shims.

---

## Tooling notes

- `bash scripts/install-hooks.sh` — installs pre-commit (lint-tenancy) and pre-push (typecheck + tests + TS18046 ratchet).
- `node scripts/lint-tenancy.mjs` — manual run of the tenancy lint.
- `pnpm -r typecheck` / `pnpm -r test` — full workspace checks (also what pre-push runs).
- Codex review (`/codex`) is currently paused — see [[feedback-codex-pause]] in MEMORY.md. Ask the user before resuming.

---

## When in doubt

- If a change might break an invariant, FLAG it before shipping. The user reviews seriously and would rather have a flagged risk than a silently-shipped one.
- If you're about to add code that crosses a deferred-backlog trigger (migration runner, mcp-gateway tenancy, real auth), surface that first.
- "You pick" / "the best" from the user means decide-and-proceed with rationale, NOT ask again.

---

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
