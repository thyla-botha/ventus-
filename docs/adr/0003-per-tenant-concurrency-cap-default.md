# 0003 — Per-tenant concurrency cap default of 5

- **Status:** Accepted
- **Date:** 2026-05-26
- **Deciders:** Implementer (judgement call, user delegated via "the best")

## Context

Earlier code review flagged HIGH: a single tenant could fan out unbounded agent loops via POST /v1/runs, consuming API CPU, file-store write locks, and Anthropic quota until the process died or the bill exploded.

We needed a cap. The question was what value, and where to enforce it.

## Decision

Per-tenant in-process loop count capped at `VENTUS_PER_TENANT_RUN_CAP` (default **5**). Enforcement is a synchronous claim/release Map on `AppState` (single-threaded Node makes it atomic without locking). POST /v1/runs returns 429 when over cap.

## Alternatives considered

- **Default 1** — strictest. Trade-off: any tenant doing parallel work (multi-agent pack, batch processing) hits cap instantly. Punishes legitimate use.
- **Default 5** *(chosen)* — generous enough for typical "agent + tools" patterns and small batch jobs; tight enough that a runaway script hits the wall in seconds. Easy to override per-deployment.
- **Default 50 / unbounded by default** — defers the problem to ops monitoring. Trade-off: we're not running ops monitoring yet, and "unbounded" was the bug we just fixed.
- **Global cap instead of per-tenant** — simpler bookkeeping but tenant A could starve tenant B. Defeats the multi-tenant fairness goal.

## Consequences

- **5 is a guess.** We have no production load data. The right number depends on tenant patterns we haven't seen yet. Revisit when (a) a real customer reports hitting the wall on legitimate work, or (b) we add metrics that let us measure actual concurrency distribution.
- **Counts in-process loops only** — a 'running' row from a crashed peer is the reaper's job, not this counter's. If we ever shard the API across multiple processes, per-process counters need a coordination mechanism (Redis or DB-backed) — otherwise the global cap is N × per-process.
- 429 response shape is `{ error, cap }` so clients can implement client-side backoff intelligently.

## Notes

Wired in [apps/api/src/routes/runs.ts](../../apps/api/src/routes/runs.ts) and [apps/api/src/state.ts](../../apps/api/src/state.ts). Tests in [apps/api/src/routes/runs-concurrency.test.ts](../../apps/api/src/routes/runs-concurrency.test.ts).

Memory: see [project-architecture-decisions](../../).
