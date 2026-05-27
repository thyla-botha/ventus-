import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTenantProfileStore } from './tenant-profile-file.js';
import { MAX_TENANT_PROFILE_LEN } from './types.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

describe('FileTenantProfileStore', () => {
  let dir: string;
  let store: FileTenantProfileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-tenant-profile-'));
    store = new FileTenantProfileStore(join(dir, 'tenant-profile.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when a tenant has no profile', async () => {
    expect(await store.get(TENANT_A)).toBeNull();
  });

  it('persists a body and assigns contentHash + updatedAt', async () => {
    const p = await store.set(TENANT_A, '# Acme Real Estate\nBrand voice: warm.', {
      updatedBy: 'admin-1',
    });
    expect(p.tenantId).toBe(TENANT_A);
    expect(p.body).toBe('# Acme Real Estate\nBrand voice: warm.');
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(p.updatedBy).toBe('admin-1');

    const fetched = await store.get(TENANT_A);
    expect(fetched).toEqual(p);
  });

  it('trims leading/trailing whitespace on write', async () => {
    const p = await store.set(TENANT_A, '   hello world\n\n', { updatedBy: 'u' });
    expect(p.body).toBe('hello world');
  });

  it('overwrites the prior profile on a fresh set (no history kept)', async () => {
    const a = await store.set(TENANT_A, 'first', { updatedBy: 'u' });
    const b = await store.set(TENANT_A, 'second', { updatedBy: 'u' });
    expect(a.contentHash).not.toBe(b.contentHash);
    const fetched = await store.get(TENANT_A);
    expect(fetched?.body).toBe('second');
    expect(fetched?.contentHash).toBe(b.contentHash);
  });

  it('isolates profiles across tenants', async () => {
    await store.set(TENANT_A, 'A profile', { updatedBy: 'u' });
    await store.set(TENANT_B, 'B profile', { updatedBy: 'u' });
    expect((await store.get(TENANT_A))?.body).toBe('A profile');
    expect((await store.get(TENANT_B))?.body).toBe('B profile');
  });

  it('rejects bodies larger than MAX_TENANT_PROFILE_LEN', async () => {
    const tooBig = 'x'.repeat(MAX_TENANT_PROFILE_LEN + 1);
    await expect(store.set(TENANT_A, tooBig, { updatedBy: 'u' })).rejects.toThrow(
      /exceeds .* chars/,
    );
    // And nothing was written.
    expect(await store.get(TENANT_A)).toBeNull();
  });

  it('accepts a body at exactly MAX_TENANT_PROFILE_LEN', async () => {
    const body = 'x'.repeat(MAX_TENANT_PROFILE_LEN);
    const p = await store.set(TENANT_A, body, { updatedBy: 'u' });
    expect(p.body.length).toBe(MAX_TENANT_PROFILE_LEN);
  });

  it('accepts an empty body and hashes it deterministically', async () => {
    const p1 = await store.set(TENANT_A, '', { updatedBy: 'u' });
    const p2 = await store.set(TENANT_B, '', { updatedBy: 'u' });
    expect(p1.body).toBe('');
    expect(p1.contentHash).toBe(p2.contentHash);
    // Empty profile is still a profile — get() returns it, not null.
    expect(await store.get(TENANT_A)).not.toBeNull();
  });

  it('contentHash is deterministic for identical bodies', async () => {
    const a = await store.set(TENANT_A, 'same body', { updatedBy: 'u' });
    const b = await store.set(TENANT_B, 'same body', { updatedBy: 'u' });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('serialises concurrent writes for the same tenant', async () => {
    // RMW safety: ten parallel writes must all complete and the final
    // contentHash must match exactly one of the inputs (last writer wins,
    // no partial / lost writes).
    const bodies = Array.from({ length: 10 }, (_, i) => `body-${i}`);
    await Promise.all(bodies.map((b) => store.set(TENANT_A, b, { updatedBy: 'u' })));
    const final = await store.get(TENANT_A);
    expect(final).not.toBeNull();
    expect(bodies).toContain(final?.body);
  });

  describe('setRuntime', () => {
    it('creates an empty-body profile when none exists yet', async () => {
      const p = await store.setRuntime(
        TENANT_A,
        { provider: 'ollama', model: 'llama3.1:8b' },
        { updatedBy: 'admin-1' },
      );
      expect(p.body).toBe('');
      expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
      expect(p.runtimeUpdatedBy).toBe('admin-1');
      expect(p.runtimeUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('preserves the existing body when only runtime changes', async () => {
      await store.set(TENANT_A, 'Brand voice: warm.', { updatedBy: 'u' });
      const p = await store.setRuntime(
        TENANT_A,
        { provider: 'ollama', model: 'llama3.1:8b' },
        { updatedBy: 'admin-1' },
      );
      expect(p.body).toBe('Brand voice: warm.');
      expect(p.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    });

    it('preserves the existing runtime when only body changes (set)', async () => {
      await store.setRuntime(
        TENANT_A,
        { provider: 'ollama', model: 'llama3.1:8b' },
        { updatedBy: 'admin-1' },
      );
      const p = await store.set(TENANT_A, 'new body', { updatedBy: 'u2' });
      expect(p.body).toBe('new body');
      expect(p.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    });

    it('clears the runtime when passed null', async () => {
      await store.setRuntime(
        TENANT_A,
        { provider: 'ollama', model: 'llama3.1:8b' },
        { updatedBy: 'admin-1' },
      );
      const p = await store.setRuntime(TENANT_A, null, { updatedBy: 'admin-2' });
      expect(p.runtime).toBeUndefined();
      expect(p.runtimeUpdatedBy).toBe('admin-2');
    });

    it('rejects empty provider or model', async () => {
      await expect(
        store.setRuntime(TENANT_A, { provider: '', model: 'x' }, { updatedBy: 'u' }),
      ).rejects.toThrow(/provider/);
      await expect(
        store.setRuntime(TENANT_A, { provider: 'x', model: '' }, { updatedBy: 'u' }),
      ).rejects.toThrow(/model/);
    });

    it('trims runtime fields on write', async () => {
      const p = await store.setRuntime(
        TENANT_A,
        { provider: '  ollama  ', model: '  llama3.1:8b  ' },
        { updatedBy: 'u' },
      );
      expect(p.runtime).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    });
  });
});
