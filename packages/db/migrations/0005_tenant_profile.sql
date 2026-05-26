-- Tenant profile: bounded, read-only-at-runtime markdown body that's injected
-- at the top of every Run's system prompt for a given tenant. Single row per
-- tenant — overwritten in place; history (if/when needed) will live in a
-- separate tenant_profile_history table. The body itself is mutable; what
-- this migration also adds is the per-Run snapshot column (runs.tenant_profile_hash)
-- so an auditor can always tell which version of the profile a given run saw.
--
-- The 4_000-char cap matches MAX_TENANT_PROFILE_LEN in packages/store and is
-- enforced at the application layer; the DB cap is set higher (8_000) as a
-- defence-in-depth backstop in case the app cap is ever bypassed.

CREATE TABLE tenant_profiles (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  body         text NOT NULL CHECK (char_length(body) <= 8000),
  content_hash text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE tenant_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_profiles_tenant_iso ON tenant_profiles
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Snapshot column on the Run row: hash of the tenant_profile body that THIS
-- run saw (NULL when the tenant had no profile at run time). Folded into the
-- run's context_snapshot_hash so the snapshot is unique per profile version.
ALTER TABLE runs
  ADD COLUMN tenant_profile_hash text;

-- Lookup index: "find every run that used profile snapshot X" — useful when
-- diffing behaviour across profile edits. Partial because most older rows
-- predate the column and will be NULL.
CREATE INDEX runs_tenant_profile_idx
  ON runs(tenant_id, tenant_profile_hash)
  WHERE tenant_profile_hash IS NOT NULL;
