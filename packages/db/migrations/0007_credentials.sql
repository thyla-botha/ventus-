-- Per-tenant credential vault.
--
-- Holds the encrypted blobs that the FileCredentialStore wrote to a single
-- JSON file in dev. Production cannot rely on a file that disappears with
-- the container — this table is what production points at.
--
-- The on-row shape mirrors EncryptedBlob from packages/credentials/src/crypto.ts:
-- blob_version + blob_data (base64-encoded iv+tag+ciphertext). The encryption
-- happens in the application tier with a master key derived from
-- VENTUS_CREDENTIAL_MASTER_KEY plus the tenant_id; Postgres never sees the
-- plaintext token. Service-role access bypasses RLS — same discipline as
-- every other tenant-scoped table.
--
-- Why a new table instead of extending `connectors` (0001): connectors holds
-- connector metadata (display_name, status, scopes, external_account_id) and
-- its OAuth fields are sharded across cipher/iv/tag bytea columns. We
-- standardized on a single combined-blob format because (a) every
-- application-tier caller uses one blob anyway and (b) we also store
-- per-tenant LLM provider API keys (llm_openai/llm_anthropic/llm_openrouter
-- — see PR 2), which are not "connectors" at all. Splitting credential
-- storage from connector metadata also makes future rotation simpler: rotate
-- credentials.blob_data without churning the metadata row.
--
-- The connector_type column is a free-form text rather than an enum so we
-- don't have to ship a migration every time we add a connector. The
-- application layer (packages/credentials/src/store.ts:ConnectorType) is
-- the authoritative whitelist.

CREATE TABLE credentials (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_type  text NOT NULL,
  blob_version    int  NOT NULL,
  blob_data       text NOT NULL,
  key_version     int  NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  PRIMARY KEY (tenant_id, connector_type)
);
CREATE INDEX credentials_tenant_idx ON credentials(tenant_id);

-- RLS. Same shape as every other tenant-scoped table (see 0003_rls.sql).
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY credentials_tenant_iso ON credentials
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Touch updated_at on every overwrite. The application also passes the
-- timestamp explicitly in the UPSERT, but a trigger guards against direct
-- SQL updates that forget it.
CREATE OR REPLACE FUNCTION app.credentials_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER credentials_touch_updated_at
  BEFORE UPDATE ON credentials
  FOR EACH ROW EXECUTE FUNCTION app.credentials_touch_updated_at();
