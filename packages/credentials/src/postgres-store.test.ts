import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresCredentialStore,
  type PgQuerier,
  type PgTenantRunner,
} from './postgres-store.js';
import { encryptCredential } from './crypto.js';

// Tests live without a real Postgres by stubbing PgTenantRunner. Each test
// asserts BOTH the SQL template shape (header text) AND the runtime
// behaviour (decrypt, list shape, upsert). An integration test against a
// real DB lives elsewhere — gated by DATABASE_URL_TEST so CI without
// Postgres still passes.

const MASTER_KEY = Buffer.from('p'.repeat(32)).toString('base64');

interface CapturedCall {
  // The SQL template joined with placeholders ('?') so we can assert the
  // statement shape without per-test regex.
  sql: string;
  values: unknown[];
}

interface StubBehaviour {
  // For each call, return either a static row set or a function that
  // receives (sql, values) and produces rows. Empty queue → throw.
  responses: Array<unknown[] | ((sql: string, values: unknown[]) => unknown[])>;
}

class StubRunner implements PgTenantRunner {
  calls: CapturedCall[] = [];
  txCount = 0;
  lastTenantId: string | undefined;
  lastUserId: string | undefined;
  constructor(private readonly behaviour: StubBehaviour) {}

  async withTenant<T>(
    ctx: { tenantId: string; userId?: string },
    fn: (sql: PgQuerier) => Promise<T>,
  ): Promise<T> {
    this.txCount++;
    this.lastTenantId = ctx.tenantId;
    this.lastUserId = ctx.userId;
    const querier: PgQuerier = (async <U = unknown>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<U[]> => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      this.calls.push({ sql, values });
      const next = this.behaviour.responses.shift();
      if (!next) throw new Error('StubRunner: no scripted response left');
      const rows = typeof next === 'function' ? next(sql, values) : next;
      return rows as U[];
    }) as PgQuerier;
    return fn(querier);
  }
}

describe('PostgresCredentialStore', () => {
  let priorMaster: string | undefined;
  beforeEach(() => {
    priorMaster = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
    process.env.VENTUS_CREDENTIAL_MASTER_KEY = MASTER_KEY;
  });
  afterEach(() => {
    if (priorMaster === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
    else process.env.VENTUS_CREDENTIAL_MASTER_KEY = priorMaster;
  });

  it('get() returns null when no row exists', async () => {
    const runner = new StubRunner({ responses: [[]] });
    const store = new PostgresCredentialStore(runner);
    const result = await store.get('t1', 'gmail');
    expect(result).toBeNull();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.sql).toMatch(/SELECT blob_version, blob_data/);
    expect(runner.calls[0]?.sql).toMatch(/FROM credentials/);
    expect(runner.calls[0]?.sql).toMatch(/WHERE tenant_id = \?/);
    // Tenant context was set.
    expect(runner.lastTenantId).toBe('t1');
  });

  it('get() decrypts the stored blob and returns the plaintext', async () => {
    // Generate a real encrypted blob for tenant 't1' with the test master key.
    const blob = encryptCredential('t1', 'sk-real-secret-12345');
    const runner = new StubRunner({
      responses: [
        [
          {
            blob_version: blob.version,
            blob_data: blob.data,
            key_version: blob.version,
            updated_at: '2026-05-29T10:00:00.000Z',
            updated_by: 'admin@example.com',
          },
        ],
      ],
    });
    const store = new PostgresCredentialStore(runner);
    const result = await store.get('t1', 'gmail');
    expect(result).toBe('sk-real-secret-12345');
  });

  it('get() throws on decrypt failure (wrong tenant / tampered blob)', async () => {
    // Encrypt under tenant 't1' but decrypt as 't2' — derives a different
    // subkey, GCM auth tag fails.
    const blob = encryptCredential('t1', 'plaintext');
    const runner = new StubRunner({
      responses: [
        [
          {
            blob_version: blob.version,
            blob_data: blob.data,
            key_version: blob.version,
            updated_at: '2026-05-29T10:00:00.000Z',
            updated_by: null,
          },
        ],
      ],
    });
    const store = new PostgresCredentialStore(runner);
    await expect(store.get('t2', 'gmail')).rejects.toThrow(/decrypt failed/);
  });

  it('list() returns metadata only, never plaintext', async () => {
    const runner = new StubRunner({
      responses: [
        [
          {
            connector_type: 'gmail',
            updated_at: '2026-05-29T10:00:00.000Z',
            updated_by: 'admin',
            key_version: 1,
          },
          {
            connector_type: 'llm_openai',
            updated_at: '2026-05-29T11:00:00.000Z',
            updated_by: null,
            key_version: 1,
          },
        ],
      ],
    });
    const store = new PostgresCredentialStore(runner);
    const out = await store.list('t1');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      tenantId: 't1',
      connectorType: 'gmail',
      updatedAt: '2026-05-29T10:00:00.000Z',
      updatedBy: 'admin',
      keyVersion: 1,
    });
    expect(out[1]).toEqual({
      tenantId: 't1',
      connectorType: 'llm_openai',
      updatedAt: '2026-05-29T11:00:00.000Z',
      keyVersion: 1,
    });
    // No `apiKey` or `blob_data` field in the returned shape.
    expect(JSON.stringify(out)).not.toMatch(/blob_data/);
  });

  it('list() drops rows with unknown connector_type values defensively', async () => {
    // A future migration might add a new connector type; the old code path
    // shouldn't crash on a row it doesn't recognize.
    const runner = new StubRunner({
      responses: [
        [
          {
            connector_type: 'gmail',
            updated_at: '2026-05-29T10:00:00.000Z',
            updated_by: null,
            key_version: 1,
          },
          {
            connector_type: 'salesforce', // not in ConnectorType union
            updated_at: '2026-05-29T11:00:00.000Z',
            updated_by: null,
            key_version: 1,
          },
        ],
      ],
    });
    const store = new PostgresCredentialStore(runner);
    const out = await store.list('t1');
    expect(out).toHaveLength(1);
    expect(out[0]?.connectorType).toBe('gmail');
  });

  it('set() upserts with the encrypted blob and returns metadata (never plaintext)', async () => {
    const runner = new StubRunner({
      responses: [[{ updated_at: '2026-05-29T12:00:00.000Z' }]],
    });
    const store = new PostgresCredentialStore(runner);
    const meta = await store.set('t1', 'gmail', 'sk-real-token-XYZ', {
      updatedBy: 'admin@example.com',
    });
    expect(meta).toEqual({
      tenantId: 't1',
      connectorType: 'gmail',
      updatedAt: '2026-05-29T12:00:00.000Z',
      updatedBy: 'admin@example.com',
      keyVersion: 1,
    });
    expect(runner.calls).toHaveLength(1);
    // SQL shape: must be an INSERT ... ON CONFLICT DO UPDATE (upsert).
    expect(runner.calls[0]?.sql).toMatch(/INSERT INTO credentials/);
    expect(runner.calls[0]?.sql).toMatch(/ON CONFLICT/);
    expect(runner.calls[0]?.sql).toMatch(/DO UPDATE SET/);
    // The bound values must contain the encrypted blob (not the plaintext).
    const values = runner.calls[0]?.values ?? [];
    const stringified = JSON.stringify(values);
    expect(stringified).not.toContain('sk-real-token-XYZ');
    // The values include the tenantId, connectorType, version, blob.data, etc.
    expect(values).toContain('t1');
    expect(values).toContain('gmail');
  });

  it('set() throws when the token is empty', async () => {
    const runner = new StubRunner({ responses: [] });
    const store = new PostgresCredentialStore(runner);
    await expect(store.set('t1', 'gmail', '')).rejects.toThrow(/non-empty/);
  });

  it('delete() runs a tenant-scoped DELETE', async () => {
    const runner = new StubRunner({ responses: [[]] });
    const store = new PostgresCredentialStore(runner);
    await store.delete('t1', 'gmail');
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.sql).toMatch(/^DELETE FROM credentials/);
    expect(runner.calls[0]?.values).toContain('t1');
    expect(runner.calls[0]?.values).toContain('gmail');
  });

  it('every operation runs inside a tenant-scoped transaction', async () => {
    const blob = encryptCredential('t1', 'value');
    const runner = new StubRunner({
      responses: [
        [], // get -> empty
        [
          {
            blob_version: blob.version,
            blob_data: blob.data,
            key_version: blob.version,
            updated_at: '2026-05-29T10:00:00.000Z',
            updated_by: null,
          },
        ],
        [], // list (empty)
        [{ updated_at: '2026-05-29T12:00:00.000Z' }], // set
        [], // delete
      ],
    });
    const store = new PostgresCredentialStore(runner);
    await store.get('t1', 'gmail'); // 1
    await store.get('t1', 'gmail'); // 2
    await store.list('t1'); // 3
    await store.set('t1', 'gmail', 'value'); // 4
    await store.delete('t1', 'gmail'); // 5
    // Each operation must wrap its queries in withTenant.
    expect(runner.txCount).toBe(5);
  });

  it('round-trips an encrypted blob end-to-end (set then get)', async () => {
    // Single-row in-memory backing store so the test exercises the real
    // encrypt-then-decrypt path through application code.
    let row: {
      blob_version: number;
      blob_data: string;
      key_version: number;
      updated_at: string;
      updated_by: string | null;
    } | null = null;
    const runner = new StubRunner({
      responses: [],
    });
    // Override responses with a smarter behaviour: peek at the SQL to
    // decide what to return.
    (runner as unknown as { behaviour: StubBehaviour }).behaviour = {
      responses: [],
    };
    const original = runner.withTenant.bind(runner);
    runner.withTenant = async <T,>(
      ctx: { tenantId: string; userId?: string },
      fn: (sql: PgQuerier) => Promise<T>,
    ): Promise<T> => {
      runner.txCount++;
      runner.lastTenantId = ctx.tenantId;
      const querier: PgQuerier = (async <U = unknown>(
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<U[]> => {
        const sql = strings.join('?').replace(/\s+/g, ' ').trim();
        runner.calls.push({ sql, values });
        if (sql.startsWith('SELECT blob_version')) {
          return (row ? [row] : []) as U[];
        }
        if (sql.startsWith('INSERT INTO credentials')) {
          const [, , blobVersion, blobData, keyVersion, updatedBy] = values as [
            string,
            string,
            number,
            string,
            number,
            string | null,
          ];
          row = {
            blob_version: blobVersion,
            blob_data: blobData,
            key_version: keyVersion,
            updated_at: '2026-05-29T12:00:00.000Z',
            updated_by: updatedBy,
          };
          return [{ updated_at: '2026-05-29T12:00:00.000Z' }] as U[];
        }
        if (sql.startsWith('DELETE')) {
          row = null;
          return [] as U[];
        }
        return [] as U[];
      }) as PgQuerier;
      return fn(querier);
    };
    void original; // keep linter happy

    const store = new PostgresCredentialStore(runner);
    await store.set('t1', 'gmail', 'secret-round-trip');
    const got = await store.get('t1', 'gmail');
    expect(got).toBe('secret-round-trip');
    await store.delete('t1', 'gmail');
    const after = await store.get('t1', 'gmail');
    expect(after).toBeNull();
  });
});
