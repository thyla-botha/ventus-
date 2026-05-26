-- Ventus initial schema.
-- Every tenant-scoped table carries tenant_id and is governed by RLS in 0003.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- Helper schema + tenant-context resolver.
-- RLS policies fail closed when app.tenant_id GUC is unset, because
-- the function returns NULL and tenant_id = NULL never matches.
-- ----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.assert_tenant_set() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF app.current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'tenant context not set (app.tenant_id GUC missing)';
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- Tenancy
-- ----------------------------------------------------------------------------
CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text NOT NULL UNIQUE,
  plan             text NOT NULL DEFAULT 'pilot'
                     CHECK (plan IN ('pilot','growth','scale','enterprise')),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','archived')),
  agents_enabled   boolean NOT NULL DEFAULT true,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  encryption_key_id text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL,
  display_name  text,
  role          text NOT NULL DEFAULT 'member'
                  CHECK (role IN ('owner','admin','approver','member','viewer')),
  sso_provider  text,
  sso_subject   text,
  status        text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','invited','suspended')),
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_idx ON users(tenant_id);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX roles_tenant_idx ON roles(tenant_id);

-- ----------------------------------------------------------------------------
-- Connectors (OAuth-mediated source systems)
-- oauth tokens are stored encrypted at rest; never written in plaintext.
-- ----------------------------------------------------------------------------
CREATE TABLE connectors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type                text NOT NULL
                        CHECK (type IN ('gmail','gdrive','slack','jira','clickup','whatsapp')),
  display_name        text,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','error','revoked')),
  oauth_token_cipher  bytea,
  oauth_token_iv      bytea,
  oauth_token_tag     bytea,
  oauth_refresh_cipher bytea,
  oauth_refresh_iv    bytea,
  oauth_refresh_tag   bytea,
  oauth_expires_at    timestamptz,
  scopes              text[] NOT NULL DEFAULT '{}',
  external_account_id text,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at        timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type, external_account_id)
);
CREATE INDEX connectors_tenant_idx ON connectors(tenant_id);
CREATE INDEX connectors_status_idx ON connectors(tenant_id, status);

-- ----------------------------------------------------------------------------
-- Knowledge layer: documents -> chunks (vector) -> entities/edges (graph)
-- ----------------------------------------------------------------------------
CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id     uuid REFERENCES connectors(id) ON DELETE SET NULL,
  source_type      text NOT NULL,
  external_id      text NOT NULL,
  external_url     text,
  type             text,
  title            text,
  raw_text         text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_timestamp timestamptz,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (tenant_id, source_type, external_id)
);
CREATE INDEX documents_tenant_idx ON documents(tenant_id);
CREATE INDEX documents_connector_idx ON documents(tenant_id, connector_id);
CREATE INDEX documents_source_ts_idx ON documents(tenant_id, source_timestamp DESC);

CREATE TABLE chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_idx   int NOT NULL,
  content     text NOT NULL,
  embedding   vector(1536),
  token_count int,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_idx)
);
CREATE INDEX chunks_tenant_idx ON chunks(tenant_id);
-- HNSW gives better recall at scale than IVFFlat; tune lists/ef when traffic warrants.
CREATE INDEX chunks_embedding_idx ON chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE entities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type        text NOT NULL,
  name        text NOT NULL,
  attributes  jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, type, name)
);
CREATE INDEX entities_tenant_idx ON entities(tenant_id);
CREATE INDEX entities_type_idx ON entities(tenant_id, type);

CREATE TABLE edges (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_entity_id    uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id      uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation          text NOT NULL,
  weight            real,
  evidence_doc_ids  uuid[] NOT NULL DEFAULT '{}',
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, from_entity_id, to_entity_id, relation)
);
CREATE INDEX edges_tenant_idx ON edges(tenant_id);
CREATE INDEX edges_from_idx ON edges(tenant_id, from_entity_id);
CREATE INDEX edges_to_idx ON edges(tenant_id, to_entity_id);

CREATE TABLE memories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope        text NOT NULL CHECK (scope IN ('user','session','agent','tenant')),
  scope_ref    text,
  content      text NOT NULL,
  embedding    vector(1536),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_tenant_idx ON memories(tenant_id);
CREATE INDEX memories_scope_idx ON memories(tenant_id, scope, scope_ref);

-- ----------------------------------------------------------------------------
-- Agents, runs, proposals, decisions
-- ----------------------------------------------------------------------------
CREATE TABLE agents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  tier            int NOT NULL CHECK (tier BETWEEN 1 AND 3),
  skill_pack_id   text,
  skill_id        text,
  system_prompt   text,
  allowed_tools   text[] NOT NULL DEFAULT '{}',
  policy          jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_ceiling_cents int,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX agents_tenant_idx ON agents(tenant_id);

CREATE TABLE runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  trigger         text NOT NULL,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','halted','timeout')),
  started_at      timestamptz,
  ended_at        timestamptz,
  cost_usd_micros bigint NOT NULL DEFAULT 0,
  tokens_in       bigint NOT NULL DEFAULT 0,
  tokens_out      bigint NOT NULL DEFAULT 0,
  trace_id        text,
  error_text      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_tenant_idx ON runs(tenant_id);
CREATE INDEX runs_agent_idx ON runs(tenant_id, agent_id, created_at DESC);
CREATE INDEX runs_status_idx ON runs(tenant_id, status);

CREATE TABLE proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  action_type       text NOT NULL,
  resource_type     text,
  resource_id       text,
  payload           jsonb NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_outcome  text,
  confidence        real,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','executed','failed','expired')),
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_tenant_idx ON proposals(tenant_id);
CREATE INDEX proposals_status_idx ON proposals(tenant_id, status, created_at DESC);
CREATE INDEX proposals_run_idx ON proposals(tenant_id, run_id);

CREATE TABLE decisions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  proposal_id   uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  approver_id   uuid REFERENCES users(id),
  verdict       text NOT NULL CHECK (verdict IN ('approved','rejected','edited')),
  comment       text,
  edited_payload jsonb,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  executed_at   timestamptz,
  UNIQUE (proposal_id)
);
CREATE INDEX decisions_tenant_idx ON decisions(tenant_id);
