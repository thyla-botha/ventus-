-- Migration 0008: align runs + audit tables with the application's
-- RunStore / AuditStore contract so PostgresRunStore and PostgresAuditStore
-- can replace FileRunStore / FileAuditStore with zero behaviour change.
--
-- Two parts:
--   1. Runs: add fields the agent runtime writes (skill_id, model,
--      user_message, total_cost_micros, proposal_count, final_text,
--      halt_reason, cancel_*) and widen status to include 'completed' and
--      'aborted'. Relax the agent_id FK + trigger NOT NULL so RunInput's
--      free-form agentId string can land.
--   2. Audit outcomes: tighten the FK to (intent_id, tenant_id) so a
--      cross-tenant outcome can't reference another tenant's intent —
--      Postgres' single-column FK bypasses RLS, leaving a hole the file
--      store closes inside its write lock. The composite FK is the
--      Postgres equivalent of FileAuditStore.AuditOutcomeReferentialError.

-- ----------------------------------------------------------------------------
-- Runs: shape parity with RunRecord
-- ----------------------------------------------------------------------------

-- `trigger` is required by the original schema but RunInput doesn't carry it.
-- Default empty string so callers that don't pass it (the agent runtime) work,
-- and legacy consumers that read `trigger` keep getting a non-null value.
ALTER TABLE runs ALTER COLUMN trigger DROP NOT NULL;
ALTER TABLE runs ALTER COLUMN trigger SET DEFAULT '';

-- RunInput.agentId is a free-form string in the application contract — not
-- necessarily a UUID and not necessarily bound to an `agents` row (CLI
-- callers, fixtures, future external agent ids). Drop the FK on runs and
-- proposals to match, and widen the type to text. Without this the agent
-- runtime hits a 23503 on every create() that doesn't first seed an `agents`
-- row, which the file store doesn't require.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_agent_id_fkey;
ALTER TABLE runs ALTER COLUMN agent_id TYPE text;

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_agent_id_fkey;
ALTER TABLE proposals ALTER COLUMN agent_id TYPE text;

-- Widen the status check. Old values stay valid so historical rows survive
-- the migration (and so a deployment running half new / half old code
-- doesn't choke); new values are what the application writes today.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN (
    -- New (RunStatus union)
    'running','completed','failed','halted','aborted',
    -- Legacy (0001 schema) — kept for old-row survival
    'queued','succeeded','timeout'
  ));

-- Application-shape fields that didn't exist in 0001.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS skill_id              text,
  ADD COLUMN IF NOT EXISTS model                 text,
  ADD COLUMN IF NOT EXISTS user_message          text,
  ADD COLUMN IF NOT EXISTS total_cost_micros     bigint,
  ADD COLUMN IF NOT EXISTS proposal_count        int,
  ADD COLUMN IF NOT EXISTS final_text            text,
  ADD COLUMN IF NOT EXISTS halt_reason           text,
  ADD COLUMN IF NOT EXISTS cancel_requested_at   timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_requested_by   text,
  -- tenant_profile_hash: nullable because absent (CLI caller, no profile
  -- tracked) and null (caller tracks profiles but the tenant has none at
  -- run-time) are both meaningful states. The application carries the
  -- distinction in TS via `string | null | undefined`; in Postgres null is
  -- the only representation of both, and the application layer maps it
  -- back to the right form based on the caller context.
  ADD COLUMN IF NOT EXISTS tenant_profile_hash   text;

-- ----------------------------------------------------------------------------
-- Audit outcomes: cross-tenant FK enforcement
-- ----------------------------------------------------------------------------
--
-- The single-column FK in 0002 (`intent_id REFERENCES audit_intents(id)`)
-- bypasses RLS — Postgres FK checks run as the table owner, ignoring the
-- per-tenant policy. So an outcome row CAN be inserted under tenant B that
-- references an intent owned by tenant A, even though both tables have RLS
-- enabled.
--
-- The fix is a composite FK on (intent_id, tenant_id). Because the FK
-- includes tenant_id on both sides, an INSERT whose tenant_id is set by RLS
-- WITH CHECK (i.e. forced to match app.tenant_id GUC) can only succeed
-- against an intent whose tenant_id matches — closing the bypass.
--
-- We add the unique key on audit_intents(id, tenant_id) so the composite
-- FK has a target to reference. (id is already PK, so this is a redundant
-- but cheap index that lets the FK validate.)

ALTER TABLE audit_intents
  ADD CONSTRAINT audit_intents_id_tenant_uk UNIQUE (id, tenant_id);

ALTER TABLE audit_outcomes
  DROP CONSTRAINT IF EXISTS audit_outcomes_intent_id_fkey;

ALTER TABLE audit_outcomes
  ADD CONSTRAINT audit_outcomes_intent_tenant_fkey
  FOREIGN KEY (intent_id, tenant_id)
  REFERENCES audit_intents(id, tenant_id)
  ON DELETE RESTRICT;
