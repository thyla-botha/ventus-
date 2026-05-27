import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from './store.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

let dir: string;
let store: FileCredentialStore;
let priorMaster: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ventus-cred-'));
  priorMaster = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  process.env.VENTUS_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
  store = new FileCredentialStore(join(dir, 'credentials.json'));
});

afterEach(async () => {
  if (priorMaster === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  else process.env.VENTUS_CREDENTIAL_MASTER_KEY = priorMaster;
  await rm(dir, { recursive: true, force: true });
});

describe('FileCredentialStore', () => {
  it('returns null for a tenant with no credentials', async () => {
    expect(await store.get(TENANT_A, 'gmail')).toBeNull();
    expect(await store.list(TENANT_A)).toEqual([]);
  });

  it('round-trips a credential through encrypt + persist + decrypt', async () => {
    const token = 'ya29.a0ARrdaM-fake-google-token';
    const meta = await store.set(TENANT_A, 'gmail', token, { updatedBy: 'user-1' });
    expect(meta.tenantId).toBe(TENANT_A);
    expect(meta.connectorType).toBe('gmail');
    expect(meta.updatedBy).toBe('user-1');
    expect(meta.keyVersion).toBe(1);

    const back = await store.get(TENANT_A, 'gmail');
    expect(back).toBe(token);
  });

  it('never writes plaintext to disk', async () => {
    // Strongest guarantee of the vault: even if someone exfiltrates the
    // backing file, no token bytes are recoverable without the master
    // key. We confirm by checking the raw file does not contain the
    // plaintext substring.
    const token = 'this-string-must-not-appear-on-disk-xyzzy';
    await store.set(TENANT_A, 'gmail', token);
    const raw = await readFile(join(dir, 'credentials.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('xyzzy');
  });

  it('isolates tenants — tenant B cannot read tenant A token even with the same store file', async () => {
    await store.set(TENANT_A, 'gmail', 'tenant-a-secret');
    // Same store, different tenant key — must NOT yield tenant A's token.
    const otherView = await store.get(TENANT_B, 'gmail');
    expect(otherView).toBeNull();
    // Listing tenant B finds nothing.
    expect(await store.list(TENANT_B)).toEqual([]);
  });

  it('overwrites the prior blob on re-set (no history)', async () => {
    await store.set(TENANT_A, 'slack', 'xoxb-old');
    await store.set(TENANT_A, 'slack', 'xoxb-new');
    expect(await store.get(TENANT_A, 'slack')).toBe('xoxb-new');
    // list still has exactly one row for this connector.
    const items = await store.list(TENANT_A);
    expect(items).toHaveLength(1);
    expect(items[0]!.connectorType).toBe('slack');
  });

  it('separates credentials by connectorType within the same tenant', async () => {
    await store.set(TENANT_A, 'gmail', 'gmail-token');
    await store.set(TENANT_A, 'slack', 'slack-token');
    expect(await store.get(TENANT_A, 'gmail')).toBe('gmail-token');
    expect(await store.get(TENANT_A, 'slack')).toBe('slack-token');
    const items = await store.list(TENANT_A);
    expect(items.map((i) => i.connectorType).sort()).toEqual(['gmail', 'slack']);
  });

  it('delete removes the row and leaves siblings intact', async () => {
    await store.set(TENANT_A, 'gmail', 'g');
    await store.set(TENANT_A, 'slack', 's');
    await store.delete(TENANT_A, 'gmail');
    expect(await store.get(TENANT_A, 'gmail')).toBeNull();
    expect(await store.get(TENANT_A, 'slack')).toBe('s');
  });

  it('delete on a missing row is a no-op (idempotent)', async () => {
    await expect(store.delete(TENANT_A, 'gmail')).resolves.toBeUndefined();
    await expect(store.delete(TENANT_A, 'gmail')).resolves.toBeUndefined();
  });

  it('prunes the tenant entry when its last credential is deleted', async () => {
    await store.set(TENANT_A, 'gmail', 'g');
    await store.delete(TENANT_A, 'gmail');
    const raw = await readFile(join(dir, 'credentials.json'), 'utf8');
    const parsed = JSON.parse(raw) as { rows: Record<string, unknown> };
    expect(parsed.rows[TENANT_A]).toBeUndefined();
  });

  it('rejects empty / non-string tokens at set time', async () => {
    await expect(store.set(TENANT_A, 'gmail', '')).rejects.toThrow(/non-empty string/);
  });

  it('serialises concurrent sets — no row is lost', async () => {
    // Two parallel sets on different connector types for the same tenant
    // must both land in the on-disk row map. The writeLock chain is what
    // guarantees this — without it the second write's RMW could read the
    // pre-write snapshot and clobber the first.
    await Promise.all([
      store.set(TENANT_A, 'gmail', 'g'),
      store.set(TENANT_A, 'slack', 's'),
    ]);
    const items = await store.list(TENANT_A);
    expect(items.map((i) => i.connectorType).sort()).toEqual(['gmail', 'slack']);
  });

  it('list never exposes ciphertext or blob shape', async () => {
    await store.set(TENANT_A, 'gmail', 'g');
    const items = await store.list(TENANT_A);
    const item = items[0]!;
    // Quick structural assertion: only metadata fields exist.
    expect(Object.keys(item).sort()).toEqual(
      ['connectorType', 'keyVersion', 'tenantId', 'updatedAt'].sort(),
    );
  });
});
