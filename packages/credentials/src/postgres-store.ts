import {
  decryptCredential,
  encryptCredential,
  type EncryptedBlob,
} from './crypto.js';
import type {
  ConnectorType,
  CredentialMetadata,
  CredentialStore,
} from './store.js';
import { isConnectorType } from './store.js';

// Postgres-backed implementation of CredentialStore. Shape parity with
// FileCredentialStore so callers swap impls via the AppState wiring with
// zero behaviour change — same get/list/set/delete contracts, same
// "decrypt errors throw, missing rows return null" rule.
//
// What this implementation does:
//   - Uses a tenant-context-aware `withTenant` helper (injected at
//     construction) so every query sets app.tenant_id GUC under the
//     surrounding transaction. RLS then enforces tenant isolation in
//     Postgres regardless of what the application code claims.
//   - Stores the encrypted blob as (blob_version, blob_data) columns
//     mirroring EncryptedBlob. Decryption happens application-side with
//     the master key — Postgres never sees plaintext.
//   - UPSERT-on-set: same (tenant_id, connector_type) PK as the on-disk
//     map's two-level shape, so re-setting overwrites cleanly.
//
// What this implementation does NOT do:
//   - It does NOT take a process-wide write lock the way FileCredentialStore
//     does. Postgres' row lock (taken implicitly by the UPSERT) is the
//     concurrency primitive here.
//   - It does NOT cache decryptions. Every get() goes to the DB; the
//     forwarder pulls per tool-call and we don't want a stale token sitting
//     in memory after a refresh.

// Minimal surface from `postgres` (the SDK) we need. Defining it locally
// instead of pulling in @ventus/db's withTenant directly keeps the
// credentials package's dependency footprint small and lets tests inject
// a stub. The real wiring (apps/api/src/state.ts) constructs the store
// with @ventus/db's withTenant.
export interface PgRow {
  [key: string]: unknown;
}

export interface PgQuerier {
  // Tagged template that returns rows. Mirrors the postgres.js call shape
  // narrowly enough for the queries here.
  <T = PgRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

export interface PgTenantRunner {
  // Runs `fn` inside a tenant-scoped transaction. The implementation must
  // SET LOCAL app.tenant_id (and optionally app.user_id) inside the
  // transaction so RLS policies on the credentials table match.
  withTenant<T>(
    ctx: { tenantId: string; userId?: string },
    fn: (sql: PgQuerier) => Promise<T>,
  ): Promise<T>;
}

interface StoredRow {
  blob_version: number;
  blob_data: string;
  key_version: number;
  updated_at: string;
  updated_by: string | null;
}

interface ListRow {
  connector_type: string;
  updated_at: string;
  updated_by: string | null;
  key_version: number;
}

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly runner: PgTenantRunner) {}

  async get(
    tenantId: string,
    connectorType: ConnectorType,
  ): Promise<string | null> {
    const rows = await this.runner.withTenant({ tenantId }, async (sql) => {
      return sql<StoredRow>`
        SELECT blob_version, blob_data, key_version, updated_at, updated_by
        FROM credentials
        WHERE tenant_id = ${tenantId} AND connector_type = ${connectorType}
        LIMIT 1
      `;
    });
    const row = rows[0];
    if (!row) return null;
    const blob: EncryptedBlob = {
      version: row.blob_version,
      data: row.blob_data,
    };
    return decryptCredential(tenantId, blob);
  }

  async list(tenantId: string): Promise<CredentialMetadata[]> {
    const rows = await this.runner.withTenant({ tenantId }, async (sql) => {
      return sql<ListRow>`
        SELECT connector_type, updated_at, updated_by, key_version
        FROM credentials
        WHERE tenant_id = ${tenantId}
        ORDER BY connector_type
      `;
    });
    const out: CredentialMetadata[] = [];
    for (const r of rows) {
      if (!isConnectorType(r.connector_type)) continue;
      out.push({
        tenantId,
        connectorType: r.connector_type as ConnectorType,
        updatedAt: normalizeTimestamp(r.updated_at),
        ...(r.updated_by ? { updatedBy: r.updated_by } : {}),
        keyVersion: r.key_version,
      });
    }
    return out;
  }

  async set(
    tenantId: string,
    connectorType: ConnectorType,
    token: string,
    opts: { updatedBy?: string } = {},
  ): Promise<CredentialMetadata> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('credential token must be a non-empty string');
    }
    const blob = encryptCredential(tenantId, token);
    const updatedByValue = opts.updatedBy ?? null;
    const rows = await this.runner.withTenant({ tenantId }, async (sql) => {
      return sql<{ updated_at: string }>`
        INSERT INTO credentials (
          tenant_id, connector_type, blob_version, blob_data, key_version, updated_by, updated_at
        ) VALUES (
          ${tenantId}, ${connectorType}, ${blob.version}, ${blob.data}, ${blob.version}, ${updatedByValue}, now()
        )
        ON CONFLICT (tenant_id, connector_type) DO UPDATE SET
          blob_version = EXCLUDED.blob_version,
          blob_data    = EXCLUDED.blob_data,
          key_version  = EXCLUDED.key_version,
          updated_by   = EXCLUDED.updated_by,
          updated_at   = now()
        RETURNING updated_at
      `;
    });
    const updatedAt = normalizeTimestamp(rows[0]?.updated_at ?? new Date().toISOString());
    return {
      tenantId,
      connectorType,
      updatedAt,
      ...(opts.updatedBy ? { updatedBy: opts.updatedBy } : {}),
      keyVersion: blob.version,
    };
  }

  async delete(
    tenantId: string,
    connectorType: ConnectorType,
  ): Promise<void> {
    await this.runner.withTenant({ tenantId }, async (sql) => {
      return sql`
        DELETE FROM credentials
        WHERE tenant_id = ${tenantId} AND connector_type = ${connectorType}
      `;
    });
  }
}

// Postgres' timestamptz comes back as either a Date or a string depending
// on the driver config. We normalize to an ISO 8601 string to match
// FileCredentialStore's contract (callers compare to other ISO strings).
function normalizeTimestamp(v: string | Date): string {
  if (v instanceof Date) return v.toISOString();
  return v;
}
