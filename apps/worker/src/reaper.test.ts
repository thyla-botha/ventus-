import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileRunStore } from '@ventus/store';
import { runReaperOnce, startReaper } from './reaper.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

// Reaper tests pin "now" so threshold math is deterministic regardless of
// wall-clock. The seed timestamp is 2026-05-26T12:00:00Z; rows are written
// with explicit heartbeats at known offsets.
const NOW_MS = new Date('2026-05-26T12:00:00.000Z').getTime();
const minusSec = (s: number) => new Date(NOW_MS - s * 1000).toISOString();

describe('runReaperOnce', () => {
  let dir: string;
  let runs: FileRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-reaper-'));
    runs = new FileRunStore(join(dir, 'runs.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reaps a row whose lastHeartbeatAt is older than the threshold', async () => {
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(120)); // 2 min stale, threshold 60s
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.scanned).toBe(1);
    expect(result.reaped).toHaveLength(1);
    expect(result.reaped[0]!.runId).toBe(row.id);
    const after = await runs.get(row.id);
    expect(after?.status).toBe('failed');
    expect(after?.errorText).toBe('no heartbeat');
    expect(after?.haltReason).toBe('reaper_stale_heartbeat');
    // Heartbeat timestamp preserved as evidence of when liveness was lost.
    expect(after?.lastHeartbeatAt).toBe(minusSec(120));
  });

  it('leaves a fresh row alone (heartbeat within threshold)', async () => {
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(5)); // 5s old, well under 60s
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.reaped).toHaveLength(0);
    const after = await runs.get(row.id);
    expect(after?.status).toBe('running');
  });

  it('ignores terminal rows entirely', async () => {
    // Closed rows are not in the 'running' filter, so they should never be
    // touched. We assert by side effect: a closed row with a stale heartbeat
    // is NOT reaped (because list({status:'running'}) excludes it).
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(300));
    await runs.complete(row.id, { status: 'completed', finalText: 'ok' });
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.scanned).toBe(0);
    expect(result.reaped).toHaveLength(0);
    const after = await runs.get(row.id);
    expect(after?.status).toBe('completed');
  });

  it('reaps a row that NEVER got a heartbeat if startedAt is old enough', async () => {
    // The runs.create() write itself may pre-date a process crash that
    // killed the loop before the first step_started fired. Without a
    // startedAt fallback, those rows would stay 'running' forever.
    // We open the row at NOW-120s by overriding the lock, then assert.
    // Easiest: create the row in the past by leaving lastHeartbeatAt unset
    // and pinning NOW to far in the future.
    await runs.create({ tenantId: TENANT, agentId: 'a' });
    // Move "now" 200s past creation so startedAt is older than threshold.
    const result = await runReaperOnce(
      { runs },
      {
        staleThresholdMs: 60_000,
        now: () => new Date(Date.now() + 200_000),
      },
    );
    expect(result.reaped).toHaveLength(1);
    const after = await runs.get(result.reaped[0]!.runId);
    expect(after?.status).toBe('failed');
  });

  it('reaps multiple stale rows in one pass', async () => {
    const a = await runs.create({ tenantId: TENANT, agentId: 'a' });
    const b = await runs.create({ tenantId: TENANT, agentId: 'a' });
    const c = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(a.id, minusSec(120));
    await runs.heartbeat(b.id, minusSec(90));
    await runs.heartbeat(c.id, minusSec(5)); // fresh
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.reaped.map((r) => r.runId).sort()).toEqual([a.id, b.id].sort());
    expect(result.scanned).toBe(3);
  });

  it('does not panic when there are no running rows', async () => {
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.scanned).toBe(0);
    expect(result.reaped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    // Observability fields populated even on silent ticks (empty histogram +
    // a non-negative duration). A silent tick IS a useful signal — it proves
    // the reaper is alive and the store is reachable.
    expect(result.reapedByTenant).toEqual({});
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a per-tenant reap histogram', async () => {
    // Observability: ops needs to spot "tenant X generates 80% of the
    // reaps" without grepping reaped[].tenantId. The histogram is the
    // first thing a scraper picks up.
    const TENANT_B = '00000000-0000-0000-0000-00000000000b';
    const a1 = await runs.create({ tenantId: TENANT, agentId: 'a' });
    const a2 = await runs.create({ tenantId: TENANT, agentId: 'a' });
    const b1 = await runs.create({ tenantId: TENANT_B, agentId: 'a' });
    await runs.heartbeat(a1.id, minusSec(120));
    await runs.heartbeat(a2.id, minusSec(120));
    await runs.heartbeat(b1.id, minusSec(120));
    const result = await runReaperOnce(
      { runs },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    expect(result.reaped).toHaveLength(3);
    expect(result.reapedByTenant).toEqual({
      [TENANT]: 2,
      [TENANT_B]: 1,
    });
  });

  it('tolerates a race where the row closes between list() and the store write', async () => {
    // The loop's own try/finally can close the row at the same moment the
    // reaper decides to. Once the row is no longer 'running', reapIfStale
    // must return null (no kill, no error) — the row IS where we wanted it.
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(120));

    // Build a deliberately-racy view of the store: list() returns the row
    // as still 'running', but the actual store row has already terminated.
    await runs.complete(row.id, { status: 'completed' });
    const racyRuns = {
      list: async () => [
        { ...(await runs.get(row.id))!, status: 'running' as const },
      ],
      complete: runs.complete.bind(runs),
      get: runs.get.bind(runs),
      create: runs.create.bind(runs),
      requestCancel: runs.requestCancel.bind(runs),
      heartbeat: runs.heartbeat.bind(runs),
      reapIfStale: runs.reapIfStale.bind(runs),
    };
    const result = await runReaperOnce(
      { runs: racyRuns },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );
    // The race counts as "already closed" — not an error, not a reap.
    expect(result.reaped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('does NOT reap a row whose heartbeat refreshes between list() and the store write', async () => {
    // Regression for codex HIGH-3: the loop emits step_started and fires
    // heartbeat() as fire-and-forget. Under contention, that write can queue
    // behind other writers. Meanwhile the reaper's list() may have already
    // snapshot the row with an older heartbeat. Before this fix, the reaper
    // would call complete() and kill a LIVE run because the snapshot showed
    // it as stale. The fix: reapIfStale re-checks lastHeartbeatAt under the
    // store's writeLock — a fresh heartbeat means "loop alive, don't kill".
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    // First heartbeat is old (120s ago). list() sees this and decides stale.
    await runs.heartbeat(row.id, minusSec(120));

    // Wrap list() so that AFTER the reaper takes its snapshot, but BEFORE
    // it tries to reap, we land a fresh heartbeat. This is the exact race
    // codex HIGH-3 describes (queued heartbeat lands between snapshot and
    // reaper write).
    const realList = runs.list.bind(runs);
    const racyRuns = {
      list: async (filter?: Parameters<typeof realList>[0]) => {
        const snapshot = await realList(filter);
        // Loop's heartbeat fires (and lands) after the reaper's snapshot.
        await runs.heartbeat(row.id, minusSec(1));
        return snapshot;
      },
      complete: runs.complete.bind(runs),
      get: runs.get.bind(runs),
      create: runs.create.bind(runs),
      requestCancel: runs.requestCancel.bind(runs),
      heartbeat: runs.heartbeat.bind(runs),
      reapIfStale: runs.reapIfStale.bind(runs),
    };

    const result = await runReaperOnce(
      { runs: racyRuns },
      { staleThresholdMs: 60_000, now: () => new Date(NOW_MS) },
    );

    // Reaper saw the snapshot as stale but the fresh heartbeat saved the row.
    expect(result.reaped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    const after = await runs.get(row.id);
    expect(after?.status).toBe('running');
    expect(after?.lastHeartbeatAt).toBe(minusSec(1));
  });
});

describe('startReaper', () => {
  let dir: string;
  let runs: FileRunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-reaper-'));
    runs = new FileRunStore(join(dir, 'runs.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs an immediate sweep on startup and reaps eligible rows', async () => {
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(300));

    let result: { reaped: { runId: string }[] } | null = null;
    const handle = startReaper(
      { runs },
      {
        staleThresholdMs: 60_000,
        pollIntervalMs: 60_000, // far enough out that only the startup sweep fires
        now: () => new Date(NOW_MS),
        onResult: (r) => {
          result = r;
        },
      },
    );
    // Drain microtasks so the startup sweep finishes.
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    expect(result).not.toBeNull();
    expect(result!.reaped.map((r) => r.runId)).toEqual([row.id]);
  });

  it('stop() drains an in-flight tick before resolving', async () => {
    // Asserts the stop() contract — no writes land after stop() resolves.
    // We do this by pinning a row mid-reap, calling stop() during the tick,
    // and verifying state matches what the reaper produced (not a partial).
    const row = await runs.create({ tenantId: TENANT, agentId: 'a' });
    await runs.heartbeat(row.id, minusSec(300));
    const handle = startReaper(
      { runs },
      {
        staleThresholdMs: 60_000,
        pollIntervalMs: 10_000,
        now: () => new Date(NOW_MS),
      },
    );
    await handle.stop();
    const after = await runs.get(row.id);
    // Either still running (stop fired before complete()) or failed (after).
    // Both are valid; what matters is the row state is internally consistent
    // and no orphan endedAt-without-status leak occurred.
    expect(['running', 'failed']).toContain(after?.status);
    if (after?.status === 'failed') {
      expect(after.endedAt).toBeDefined();
    }
  });
});
