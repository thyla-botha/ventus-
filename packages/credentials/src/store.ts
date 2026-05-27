import { decryptCredential, encryptCredential, type EncryptedBlob } from './crypto.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

// Per-tenant credential store. Holds OAuth tokens (Gmail, Slack, etc.) and
// any other per-connector secret a tool call needs to forward.
//
// Invariants:
//   - The on-disk file never contains plaintext secrets. Every blob is
//     AES-256-GCM encrypted with a tenant-scoped subkey (see crypto.ts).
//   - Set/get is keyed by (tenantId, connectorType) — a tenant may have at
//     most one credential per connector type. Re-setting overwrites; the
//     prior blob is not preserved. No history table here: token rotation
//     should be an external concern (Supabase function refreshing the
//     access token in place is fine; we just store the latest).
//   - Decrypt failures throw. Callers MUST treat a decrypt error as
//     "credential unavailable" and refuse the tool call, NEVER as
//     "no credential" — those have different audit semantics.
//
// Concurrency: single in-process writeLock chain, same pattern as the
// other file-backed stores. Sufficient for the single-API-node story; a
// future Postgres adapter takes the per-row lock.

export type ConnectorType = 'gmail' | 'gdrive' | 'slack' | 'jira' | 'clickup' | 'whatsapp';

const CONNECTOR_TYPES: readonly ConnectorType[] = [
  'gmail',
  'gdrive',
  'slack',
  'jira',
  'clickup',
  'whatsapp',
];

export function isConnectorType(s: string): s is ConnectorType {
  return (CONNECTOR_TYPES as readonly string[]).includes(s);
}

// Public record — what callers see when they LIST credentials. The
// ciphertext itself is never exposed; only the metadata that proves "we
// have one and here's when it was last touched". This is the shape the
// settings page / admin endpoint will render.
export interface CredentialMetadata {
  tenantId: string;
  connectorType: ConnectorType;
  updatedAt: string;
  updatedBy?: string;
  // Sentinel that identifies which master-key version produced this blob.
  // Future rotation reads this to decide whether to re-encrypt on access.
  keyVersion: number;
}

export interface CredentialStore {
  // Fetch and decrypt. Returns null when the tenant has no credential for
  // this connector. Throws on decrypt failure (tampered blob, wrong master
  // key) — callers MUST NOT mask this as "no credential".
  get(tenantId: string, connectorType: ConnectorType): Promise<string | null>;
  // List metadata for one tenant's credentials. Never returns plaintext.
  list(tenantId: string): Promise<CredentialMetadata[]>;
  // Encrypt + persist. Overwrites any existing blob for this
  // (tenantId, connectorType) pair.
  set(
    tenantId: string,
    connectorType: ConnectorType,
    token: string,
    opts?: { updatedBy?: string },
  ): Promise<CredentialMetadata>;
  delete(tenantId: string, connectorType: ConnectorType): Promise<void>;
}

interface StoredRow {
  blob: EncryptedBlob;
  updatedAt: string;
  updatedBy?: string;
  keyVersion: number;
}

interface FileShape {
  version: 1;
  // Two-level map: tenantId -> connectorType -> StoredRow. Flat enough
  // for O(1) lookup, nested enough that `list(tenantId)` doesn't require
  // a full scan.
  rows: Record<string, Partial<Record<ConnectorType, StoredRow>>>;
}

function emptyState(): FileShape {
  return { version: 1, rows: {} };
}

export class FileCredentialStore implements CredentialStore {
  private writeLock: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    const s = await readJsonFile<FileShape>(this.path, emptyState());
    // Defensive: an older or partially-truncated file might be missing
    // the rows map. Re-init rather than blow up downstream.
    if (!s.rows || typeof s.rows !== 'object') {
      return emptyState();
    }
    return s;
  }

  async get(tenantId: string, connectorType: ConnectorType): Promise<string | null> {
    const state = await this.load();
    const row = state.rows[tenantId]?.[connectorType];
    if (!row) return null;
    return decryptCredential(tenantId, row.blob);
  }

  async list(tenantId: string): Promise<CredentialMetadata[]> {
    const state = await this.load();
    const tenant = state.rows[tenantId];
    if (!tenant) return [];
    const out: CredentialMetadata[] = [];
    for (const [k, row] of Object.entries(tenant)) {
      if (!row || !isConnectorType(k)) continue;
      out.push({
        tenantId,
        connectorType: k,
        updatedAt: row.updatedAt,
        ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
        keyVersion: row.keyVersion,
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
    const updatedAt = new Date().toISOString();
    const row: StoredRow = {
      blob,
      updatedAt,
      ...(opts.updatedBy ? { updatedBy: opts.updatedBy } : {}),
      keyVersion: blob.version,
    };
    // RMW under the lock so two parallel sets don't lose one of the rows.
    const prev = this.writeLock;
    let release: () => void = () => undefined;
    this.writeLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      const state = await this.load();
      const tenant = state.rows[tenantId] ?? {};
      tenant[connectorType] = row;
      state.rows[tenantId] = tenant;
      await writeJsonFile(this.path, state);
      return {
        tenantId,
        connectorType,
        updatedAt,
        ...(opts.updatedBy ? { updatedBy: opts.updatedBy } : {}),
        keyVersion: row.keyVersion,
      };
    } finally {
      release();
    }
  }

  async delete(tenantId: string, connectorType: ConnectorType): Promise<void> {
    const prev = this.writeLock;
    let release: () => void = () => undefined;
    this.writeLock = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      const state = await this.load();
      const tenant = state.rows[tenantId];
      if (!tenant) return;
      delete tenant[connectorType];
      // Prune empty tenant maps so listAll() doesn't show ghost rows.
      if (Object.keys(tenant).length === 0) delete state.rows[tenantId];
      await writeJsonFile(this.path, state);
    } finally {
      release();
    }
  }
}
