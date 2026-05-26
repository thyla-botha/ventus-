import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToOutbox } from './outbox.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

describe('appendToOutbox', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-outbox-'));
    path = join(dir, 'outbox.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends a single record and assigns id + deliveredAt', async () => {
    const rec = await appendToOutbox(path, {
      channel: 'email',
      proposalId: 'p1',
      tenantId: TENANT,
      payload: { to: 'a@b.com' },
    });
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.deliveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.deliveries).toHaveLength(1);
    expect(raw.deliveries[0].id).toBe(rec.id);
  });

  it('serializes concurrent appends without losing rows', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendToOutbox(path, {
          channel: 'email',
          proposalId: `p-${i}`,
          tenantId: TENANT,
          payload: { i },
        }),
      ),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(N);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.deliveries).toHaveLength(N);
    const persistedIds = new Set(raw.deliveries.map((d: { id: string }) => d.id));
    expect(persistedIds.size).toBe(N);
    // every returned record is present on disk
    for (const r of results) expect(persistedIds.has(r.id)).toBe(true);
  });

  it('isolates writeLocks per path', async () => {
    const otherPath = join(dir, 'other.json');
    await Promise.all([
      appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: {},
      }),
      appendToOutbox(otherPath, {
        channel: 'slack',
        proposalId: 'p2',
        tenantId: TENANT,
        payload: {},
      }),
    ]);
    const a = JSON.parse(await readFile(path, 'utf8'));
    const b = JSON.parse(await readFile(otherPath, 'utf8'));
    expect(a.deliveries).toHaveLength(1);
    expect(b.deliveries).toHaveLength(1);
    expect(a.deliveries[0].channel).toBe('email');
    expect(b.deliveries[0].channel).toBe('slack');
  });
});
