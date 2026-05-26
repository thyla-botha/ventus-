# 0002 — Snapshot schema v3 adds tenantProfileHash with no migration path

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** User

## Context

Run provenance is captured as a hash of (skillContentHash, contextSnapshotHash). Adding `tenant_profile.body` injection means two runs with identical skills + context but different profile bodies must hash distinctly — otherwise the audit trail can't tell them apart.

The snapshot schema was at v2. Bumping it changes the meaning of `contextSnapshotHash` for new runs.

## Decision

Bump snapshot schema to v3, including `tenantProfileHash` (null if the tenant has no profile). Persist `tenantProfileHash` on the Run row as a separate column.

Pre-v3 runs (any stored before this change) are NOT migrated. They remain readable but cannot be compared to v3 runs by provenance hash.

## Alternatives considered

- **Migrate pre-v3 runs** — recompute hashes using a synthetic null tenantProfileHash. Trade-off: would unify the comparison surface but rewrites historical audit data, which violates the immutability spirit of the audit log.
- **Keep v2 forever, add tenantProfileHash as a side-channel** — wouldn't change the canonical snapshot hash. Trade-off: clean for back-compat, but provenance comparison would need a multi-field check forever, leaking the schema-version drift into every consumer.
- **Bump to v3, abandon back-compat** *(chosen)* — clean break, audit log preserves history as-it-was-at-time-of-write.

## Consequences

- Pre-v3 runs are forever non-comparable to v3 runs by single-hash equality. Consumers that need cross-version comparison must check `snapshotSchemaVersion` first.
- No automated migration script exists. If we later need cross-version comparison, we'd write a *new* derived-column ("normalisedSnapshotHash") rather than rewriting history.
- We'd revisit when: a feature requires comparing run lineage across the v2/v3 boundary. Until then, leaving it alone is the right call.

## Notes

Persisted as `runs.tenant_profile_hash` (Postgres column, migration 0005) with a partial index on (tenant_id, tenant_profile_hash) for the "find similar runs in this tenant" query.

Listed in [project-deferred-backlog](../../) as "Schema v3 migration path."
