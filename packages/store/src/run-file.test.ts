import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRunStore } from './run-file.js';
import type { RunInput } from './types.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

function input(overrides: Partial<RunInput> = {}): RunInput {
  return {
    tenantId: TENANT_A,
    agentId: 'agent-1',
    skillId: 'customer-reply-drafter',
    model: 'claude-sonnet-4-6',
    userMessage: 'draft a reply',
    ...overrides,
  };
}

describe('FileRunStore', () => {
  let dir: string;
  let store: FileRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-run-'));
    store = new FileRunStore(join(dir, 'runs.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('returns a running run with id and startedAt', async () => {
      const r = await store.create(input());
      expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.status).toBe('running');
      expect(r.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(r.endedAt).toBeUndefined();
      expect(r.totalCostMicros).toBeUndefined();
    });

    it('persists across instances', async () => {
      const created = await store.create(input());
      const fresh = new FileRunStore(join(dir, 'runs.json'));
      const reloaded = await fresh.get(created.id);
      expect(reloaded?.id).toBe(created.id);
    });
  });

  describe('get', () => {
    it('returns null for unknown id', async () => {
      expect(await store.get('does-not-exist')).toBeNull();
    });
  });

  describe('list', () => {
    it('filters by tenantId', async () => {
      await store.create(input({ tenantId: TENANT_A }));
      await store.create(input({ tenantId: TENANT_B }));
      const onlyA = await store.list({ tenantId: TENANT_A });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]!.tenantId).toBe(TENANT_A);
    });

    it('filters by status', async () => {
      const a = await store.create(input());
      await store.create(input());
      await store.complete(a.id, { status: 'completed' });
      const running = await store.list({ status: 'running' });
      const completed = await store.list({ status: 'completed' });
      expect(running).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(completed[0]!.id).toBe(a.id);
    });

    it('filters by agentId', async () => {
      await store.create(input({ agentId: 'agent-1' }));
      await store.create(input({ agentId: 'agent-2' }));
      const only1 = await store.list({ agentId: 'agent-1' });
      expect(only1).toHaveLength(1);
      expect(only1[0]!.agentId).toBe('agent-1');
    });

    it('sorts newest first', async () => {
      const a = await store.create(input());
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.create(input());
      const all = await store.list();
      expect(all.map((r) => r.id)).toEqual([b.id, a.id]);
    });

    it('respects limit', async () => {
      await store.create(input());
      await store.create(input());
      await store.create(input());
      const out = await store.list({ limit: 2 });
      expect(out).toHaveLength(2);
    });
  });

  describe('complete', () => {
    it('flips running → completed and records accounting', async () => {
      const r = await store.create(input());
      const done = await store.complete(r.id, {
        status: 'completed',
        totalCostMicros: 5400,
        proposalCount: 1,
        finalText: 'Draft staged.',
      });
      expect(done.status).toBe('completed');
      expect(done.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(done.totalCostMicros).toBe(5400);
      expect(done.proposalCount).toBe(1);
      expect(done.finalText).toBe('Draft staged.');
    });

    it('flips running → failed with errorText', async () => {
      const r = await store.create(input());
      const done = await store.complete(r.id, {
        status: 'failed',
        errorText: 'anthropic call failed: rate limited',
      });
      expect(done.status).toBe('failed');
      expect(done.errorText).toMatch(/rate limited/);
    });

    it('flips running → halted with haltReason', async () => {
      const r = await store.create(input());
      const done = await store.complete(r.id, {
        status: 'halted',
        haltReason: 'cost_ceiling_reached',
      });
      expect(done.status).toBe('halted');
      expect(done.haltReason).toBe('cost_ceiling_reached');
    });

    it('refuses to complete a run that is not running', async () => {
      const r = await store.create(input());
      await store.complete(r.id, { status: 'completed' });
      await expect(
        store.complete(r.id, { status: 'completed' }),
      ).rejects.toThrow(/not running/);
    });

    it('throws when run is missing', async () => {
      await expect(
        store.complete('missing-id', { status: 'completed' }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('requestCancel', () => {
    it('sets cancelRequestedAt + cancelRequestedBy on a running row', async () => {
      const r = await store.create(input());
      const updated = await store.requestCancel(r.id, { requestedBy: 'user-1' });
      expect(updated).not.toBeNull();
      expect(updated!.cancelRequestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(updated!.cancelRequestedBy).toBe('user-1');
      // The status stays 'running' — the loop is responsible for flipping it
      // to 'aborted' once it observes the cancel signal.
      expect(updated!.status).toBe('running');
    });

    it('persists the cancel marker so the next get() sees it', async () => {
      const r = await store.create(input());
      await store.requestCancel(r.id, { requestedBy: 'user-2' });
      const re = await store.get(r.id);
      expect(re?.cancelRequestedAt).toBeDefined();
      expect(re?.cancelRequestedBy).toBe('user-2');
    });

    it('is idempotent: a second cancel does not overwrite the first marker', async () => {
      const r = await store.create(input());
      const first = await store.requestCancel(r.id, {
        requestedBy: 'user-1',
        at: '2026-01-01T00:00:00.000Z',
      });
      const second = await store.requestCancel(r.id, {
        requestedBy: 'user-2',
        at: '2026-01-02T00:00:00.000Z',
      });
      expect(second?.cancelRequestedAt).toBe(first?.cancelRequestedAt);
      expect(second?.cancelRequestedBy).toBe('user-1');
    });

    it('does not mutate a row that has already terminated', async () => {
      const r = await store.create(input());
      await store.complete(r.id, { status: 'completed' });
      const after = await store.requestCancel(r.id, { requestedBy: 'user-1' });
      // Returns the existing terminal row so callers can distinguish from
      // "not found", but the row itself is unchanged.
      expect(after?.status).toBe('completed');
      expect(after?.cancelRequestedAt).toBeUndefined();
    });

    it('returns null when the run does not exist', async () => {
      const res = await store.requestCancel('missing-id', { requestedBy: 'user-1' });
      expect(res).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('sets lastHeartbeatAt on a running row', async () => {
      const r = await store.create(input());
      const at = '2026-05-26T10:00:00.000Z';
      const updated = await store.heartbeat(r.id, at);
      expect(updated?.lastHeartbeatAt).toBe(at);
      expect(updated?.status).toBe('running');
    });

    it('uses a fresh timestamp when no `at` arg is provided', async () => {
      const r = await store.create(input());
      const before = Date.now();
      const updated = await store.heartbeat(r.id);
      const after = Date.now();
      expect(updated?.lastHeartbeatAt).toBeDefined();
      const ms = new Date(updated!.lastHeartbeatAt!).getTime();
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);
    });

    it('returns null when the run does not exist', async () => {
      const res = await store.heartbeat('missing-id');
      expect(res).toBeNull();
    });

    it('no-ops on a terminal row and returns the existing row unchanged', async () => {
      // Race condition under test: the reaper is closing a stuck row at the
      // same moment the loop tries to write a heartbeat. If heartbeat threw
      // here, every reaped run would log a spurious error. We return the
      // terminal row instead so the caller can detect the race if it cares.
      const r = await store.create(input());
      await store.complete(r.id, { status: 'failed', errorText: 'no heartbeat' });
      const after = await store.heartbeat(r.id);
      expect(after?.status).toBe('failed');
      expect(after?.lastHeartbeatAt).toBeUndefined();
    });

    it('overwrites a prior heartbeat (latest-write-wins)', async () => {
      const r = await store.create(input());
      await store.heartbeat(r.id, '2026-05-26T10:00:00.000Z');
      await store.heartbeat(r.id, '2026-05-26T10:00:05.000Z');
      const row = await store.get(r.id);
      expect(row?.lastHeartbeatAt).toBe('2026-05-26T10:00:05.000Z');
    });
  });

  describe('concurrent writes', () => {
    it('serializes parallel creates without losing rows', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.create(input())),
      );
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(20);
      const all = await store.list();
      expect(all).toHaveLength(20);
    });
  });

  describe('reapIfStale', () => {
    const completion = { status: 'failed' as const, errorText: 'no heartbeat' };

    it('throws on malformed staleAsOf rather than silently authorising a reap', async () => {
      // NaN watermark would make the row-timestamp comparison always false
      // (referenceMs > NaN === false), opening the door to reaping every
      // running row. We'd rather surface the bug than kill live work.
      const r = await store.create(input());
      await expect(
        store.reapIfStale(r.id, { staleAsOf: 'not-a-date', completion }),
      ).rejects.toThrow(/malformed staleAsOf/);
      const after = await store.get(r.id);
      expect(after?.status).toBe('running');
    });

    it('throws when the row carries a malformed liveness timestamp', async () => {
      // Corrupt the on-disk JSON to simulate data damage. A garbage timestamp
      // is a data integrity bug — surface it instead of treating it as
      // "infinitely stale".
      const r = await store.create(input());
      await store.heartbeat(r.id, 'not-a-real-iso');
      await expect(
        store.reapIfStale(r.id, {
          staleAsOf: new Date().toISOString(),
          completion,
        }),
      ).rejects.toThrow(/malformed liveness timestamp/);
    });

    it('returns null when the row is no longer running', async () => {
      const r = await store.create(input());
      await store.complete(r.id, { status: 'completed', finalText: 'ok' });
      const out = await store.reapIfStale(r.id, {
        staleAsOf: new Date().toISOString(),
        completion,
      });
      expect(out).toBeNull();
    });

    it('returns null when a fresh heartbeat has landed past the watermark', async () => {
      const r = await store.create(input());
      await store.heartbeat(r.id, new Date().toISOString());
      // Watermark in the past; current heartbeat is "newer" than stale window.
      const out = await store.reapIfStale(r.id, {
        staleAsOf: new Date(Date.now() - 60_000).toISOString(),
        completion,
      });
      expect(out).toBeNull();
      const after = await store.get(r.id);
      expect(after?.status).toBe('running');
    });

    it('reaps when row is still running and reference timestamp is at/below watermark', async () => {
      const r = await store.create(input());
      const old = new Date(Date.now() - 5 * 60_000).toISOString();
      await store.heartbeat(r.id, old);
      const reaped = await store.reapIfStale(r.id, {
        staleAsOf: new Date().toISOString(),
        completion: { ...completion, haltReason: 'reaper_stale_heartbeat' },
      });
      expect(reaped?.status).toBe('failed');
      expect(reaped?.haltReason).toBe('reaper_stale_heartbeat');
      // Evidence preserved: original stale heartbeat timestamp not touched.
      expect(reaped?.lastHeartbeatAt).toBe(old);
    });
  });
});
