-- Row-Level Security.
-- Every tenant-scoped table enables RLS and applies a single policy that
-- ties row access to app.current_tenant_id(), which reads the session GUC.
--
-- IMPORTANT operational discipline:
--   1. Set app.tenant_id GUC PER REQUEST on every pooled connection checkout.
--      PgBouncer transaction mode does NOT persist GUCs across checkouts;
--      use SET LOCAL inside a transaction, or reset via DISCARD ALL.
--   2. The service-role key BYPASSES RLS. Use only from packages/db/admin.ts.
--   3. Background workers must set tenant_id from the job payload before any
--      tenant-scoped query. No exceptions.

-- ----------------------------------------------------------------------------
-- Enable RLS
-- ----------------------------------------------------------------------------
ALTER TABLE tenants         ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors      ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE edges           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories        ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_intents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_outcomes  ENABLE ROW LEVEL SECURITY;

-- Tenants table: a row is visible to itself only (members of that tenant).
CREATE POLICY tenant_self_visible ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- All other tenant-scoped tables: single policy across all operations.
CREATE POLICY users_tenant_iso ON users
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY roles_tenant_iso ON roles
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY connectors_tenant_iso ON connectors
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY documents_tenant_iso ON documents
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY chunks_tenant_iso ON chunks
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY entities_tenant_iso ON entities
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY edges_tenant_iso ON edges
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY memories_tenant_iso ON memories
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY agents_tenant_iso ON agents
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY runs_tenant_iso ON runs
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY proposals_tenant_iso ON proposals
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY decisions_tenant_iso ON decisions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_intents_tenant_iso ON audit_intents
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_outcomes_tenant_iso ON audit_outcomes
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
