-- Two-phase audit log.
-- audit_intents: written BEFORE an action is attempted.
-- audit_outcomes: written AFTER the action completes (success, failure, or rollback).
-- Joining intent -> outcome by intent_id gives a tamper-evident record where
-- "claimed action" and "actual result" are separable. Avoids the ghost-action
-- failure mode of a single pre-execution write.
--
-- Both tables are append-only at the application boundary. Triggers below
-- block UPDATE and DELETE for non-superuser roles.

CREATE TABLE audit_intents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id        uuid REFERENCES runs(id) ON DELETE RESTRICT,
  step_no       int NOT NULL DEFAULT 0,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_id      uuid,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  tool_name     text,
  payload       jsonb,
  payload_hash  text,
  ip_address    inet,
  user_agent    text,
  proposed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_intents_tenant_idx ON audit_intents(tenant_id, proposed_at DESC);
CREATE INDEX audit_intents_run_idx ON audit_intents(tenant_id, run_id);
CREATE INDEX audit_intents_resource_idx ON audit_intents(tenant_id, resource_type, resource_id);

CREATE TABLE audit_outcomes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id     uuid NOT NULL UNIQUE REFERENCES audit_intents(id) ON DELETE RESTRICT,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  status        text NOT NULL CHECK (status IN
                  ('executed','failed','rolled_back','approved','rejected','timeout','dropped')),
  result        jsonb,
  result_hash   text,
  error_text    text,
  duration_ms   int,
  cost_usd_micros bigint,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_outcomes_tenant_idx ON audit_outcomes(tenant_id, recorded_at DESC);
CREATE INDEX audit_outcomes_status_idx ON audit_outcomes(tenant_id, status);

-- ----------------------------------------------------------------------------
-- Append-only enforcement.
-- Service-role / superuser bypasses by design for legal redaction workflows;
-- application-tier code never has those privileges.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.audit_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('postgres','supabase_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'audit table is append-only (table=%, op=%)', TG_TABLE_NAME, TG_OP;
END;
$$;

CREATE TRIGGER audit_intents_no_update
  BEFORE UPDATE ON audit_intents
  FOR EACH ROW EXECUTE FUNCTION app.audit_block_mutation();
CREATE TRIGGER audit_intents_no_delete
  BEFORE DELETE ON audit_intents
  FOR EACH ROW EXECUTE FUNCTION app.audit_block_mutation();

CREATE TRIGGER audit_outcomes_no_update
  BEFORE UPDATE ON audit_outcomes
  FOR EACH ROW EXECUTE FUNCTION app.audit_block_mutation();
CREATE TRIGGER audit_outcomes_no_delete
  BEFORE DELETE ON audit_outcomes
  FOR EACH ROW EXECUTE FUNCTION app.audit_block_mutation();

-- Convenience view: complete trail with outcome status (or 'orphaned' if no outcome row).
CREATE OR REPLACE VIEW audit_trail AS
SELECT
  i.id              AS intent_id,
  o.id              AS outcome_id,
  i.tenant_id,
  i.run_id,
  i.step_no,
  i.actor_type,
  i.actor_id,
  i.action,
  i.resource_type,
  i.resource_id,
  i.tool_name,
  i.payload,
  i.payload_hash,
  i.proposed_at,
  COALESCE(o.status, 'orphaned') AS status,
  o.result,
  o.result_hash,
  o.error_text,
  o.duration_ms,
  o.cost_usd_micros,
  o.recorded_at
FROM audit_intents i
LEFT JOIN audit_outcomes o ON o.intent_id = i.id;
