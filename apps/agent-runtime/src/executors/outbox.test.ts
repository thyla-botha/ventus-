import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToOutbox, OutboxIdempotencyConflictError } from './outbox.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

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

  describe('idempotencyKey', () => {
    it('uses idempotencyKey as the record id when supplied', async () => {
      const rec = await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: { to: 'a@b.com' },
        idempotencyKey: 'key-abc-123',
      });
      expect(rec.id).toBe('key-abc-123');
    });

    it('returns the existing row on second call with the same key + same tenant (no duplicate write)', async () => {
      const first = await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: { to: 'a@b.com' },
        idempotencyKey: 'idem-1',
      });
      const second = await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        // Even with a slightly different payload, dedupe by key — the first
        // delivery already committed downstream; refusing to overwrite keeps
        // the audit log honest about what was actually delivered.
        payload: { to: 'different@b.com' },
        idempotencyKey: 'idem-1',
      });
      expect(second.id).toBe(first.id);
      expect(second.deliveredAt).toBe(first.deliveredAt);
      expect(second.payload).toEqual(first.payload);

      const raw = JSON.parse(await readFile(path, 'utf8'));
      expect(raw.deliveries).toHaveLength(1);
    });

    it('throws OutboxIdempotencyConflictError on same key + different tenant', async () => {
      await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: { to: 'a@b.com' },
        idempotencyKey: 'shared-key',
      });
      await expect(
        appendToOutbox(path, {
          channel: 'email',
          proposalId: 'p2',
          tenantId: TENANT_B,
          payload: { to: 'c@d.com' },
          idempotencyKey: 'shared-key',
        }),
      ).rejects.toBeInstanceOf(OutboxIdempotencyConflictError);

      const raw = JSON.parse(await readFile(path, 'utf8'));
      expect(raw.deliveries).toHaveLength(1);
      expect(raw.deliveries[0].tenantId).toBe(TENANT);
    });

    it('falls back to randomUUID when idempotencyKey is omitted', async () => {
      const rec = await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: {},
      });
      expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('serializes concurrent appends with the same key into exactly one row', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          appendToOutbox(path, {
            channel: 'email',
            proposalId: 'p1',
            tenantId: TENANT,
            payload: { to: 'a@b.com' },
            idempotencyKey: 'concurrent-key',
          }),
        ),
      );
      // All returns reference the same row.
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      expect([...ids][0]).toBe('concurrent-key');

      const raw = JSON.parse(await readFile(path, 'utf8'));
      expect(raw.deliveries).toHaveLength(1);
    });

    it('throws on same-tenant collision when proposalId differs (guards business-key misuse)', async () => {
      // Today idempotencyKey === proposal.id so same-tenant + same-key implies
      // same proposal. If a future caller supplies a business-level key and
      // two distinct proposals collide, we MUST refuse to dedupe (returning
      // the wrong proposal's row would silently misroute the side effect).
      await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'proposal-A',
        tenantId: TENANT,
        payload: {},
        idempotencyKey: 'business-key',
      });
      await expect(
        appendToOutbox(path, {
          channel: 'email',
          proposalId: 'proposal-B',
          tenantId: TENANT,
          payload: {},
          idempotencyKey: 'business-key',
        }),
      ).rejects.toBeInstanceOf(OutboxIdempotencyConflictError);
    });

    it('survives lock-queue continuation after a conflict throw', async () => {
      // A throwing append must release the writeLock so the next append on the
      // same path still runs. Regression guard for the lock-chain.
      await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p1',
        tenantId: TENANT,
        payload: {},
        idempotencyKey: 'conflict-key',
      });
      await expect(
        appendToOutbox(path, {
          channel: 'email',
          proposalId: 'p2',
          tenantId: TENANT_B,
          payload: {},
          idempotencyKey: 'conflict-key',
        }),
      ).rejects.toBeInstanceOf(OutboxIdempotencyConflictError);
      // Subsequent append (different key) should still succeed.
      const rec = await appendToOutbox(path, {
        channel: 'email',
        proposalId: 'p3',
        tenantId: TENANT,
        payload: {},
        idempotencyKey: 'next-key',
      });
      expect(rec.id).toBe('next-key');
      const raw = JSON.parse(await readFile(path, 'utf8'));
      expect(raw.deliveries).toHaveLength(2);
    });
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
