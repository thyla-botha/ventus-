# Architecture Decision Records

This directory captures the *why* behind decisions that shape Ventus. Code comments are fine for code-adjacent context, but high-stakes decisions (accepted risks, architectural trade-offs, deferred work) get lost when files move. ADRs are append-only and versioned with the code.

## When to write one

Write an ADR when:
- You made an accepted-risk decision (chose one option knowing the others exist)
- You picked an architecture pattern that future-you would otherwise re-litigate
- You deferred work that someone else would assume was done
- You set a default (cap, threshold, timeout) by judgement, not measurement

Don't write one for:
- Implementation details visible in the diff
- Bugfixes (the commit message is enough)
- Reversible local choices ("which library for X")

## Format

Use `NNNN-short-slug.md`. Four-digit zero-padded sequence. The slug is for humans skimming the directory.

Each ADR has the structure in [TEMPLATE.md](TEMPLATE.md). Keep them short — if it's longer than two screens, it's probably two decisions.

## Status lifecycle

- **Proposed** — under discussion, not yet committed to
- **Accepted** — the decision stands; the code reflects it
- **Superseded by NNNN** — a later ADR replaces this one; do NOT edit the original, write the new one and link

Never delete an ADR. The record of *why we did X* is valuable even after we stop doing X.

## Index

- [0001 — Prompt injection in tenant_profile body is accepted risk](0001-tenant-profile-prompt-injection.md)
- [0002 — Snapshot schema v3 adds tenantProfileHash with no migration path](0002-snapshot-schema-v3.md)
- [0003 — Per-tenant concurrency cap default of 5](0003-per-tenant-concurrency-cap-default.md)
