import type { RunRecord, RunStore } from '@ventus/store';

// Reaper: scans for 'running' Run rows whose last heartbeat is older than the
// stale threshold and closes them as 'failed' with errorText='no heartbeat'.
//
// TENANCY NOTE: this is a control-plane process — it deliberately reads
// across all tenants because a stuck row is a stuck row regardless of which
// tenant owns it. On the file-store path that's safe (no RLS, the store
// is global). When we move to Postgres+RLS, the reaper will need a
// service-role connection to bypass RLS, which means it (or its store
// adapter) will have to import @ventus/db/admin. At that point the importer
// MUST be added to ALLOWED_ADMIN_IMPORTERS in scripts/lint-tenancy.mjs.
// Until then this stays clean because the file store has no tenancy concept.
//
// Why this exists: the in-process try/finally inside driveRun() reliably
// closes a Run row when the runtime throws an in-process exception. It does
// NOT cover the case where the process itself dies mid-step — SIGKILL, OOM,
// container eviction, hardware failure. Those would leave rows stuck in
// 'running' forever, which (a) leaks ops attention and (b) breaks the
// drainInflight() contract on graceful shutdown of subsequent processes.
//
// Design choices:
//   - Reads via store.list({ status: 'running' }) then filters in-memory by
//     timestamp. With a Postgres swap this becomes a WHERE clause.
//   - Closes via runs.complete(id, { status: 'failed', errorText, haltReason }).
//     We deliberately do NOT touch lastHeartbeatAt — preserved as evidence of
//     when liveness was lost.
//   - A row with NO lastHeartbeatAt is reaped only if startedAt is older than
//     the stale threshold (covers SIGKILL between create() and the first
//     heartbeat write).
//   - Reap failures are logged but never throw out of runReaperOnce(). The
//     loop's job is "make progress where possible" — a single bad row should
//     not block the rest of the queue.

export interface ReaperDeps {
  runs: RunStore;
}

export interface ReaperOptions {
  // A row is considered stale if (now - lastHeartbeatAt) exceeds this. When
  // lastHeartbeatAt is absent, (now - startedAt) is used instead. Defaults
  // to 60s — comfortably above any reasonable per-step duration but tight
  // enough that a dead loop is detected in a single shift.
  staleThresholdMs?: number;
  // Optional override of "now" for testing.
  now?: () => Date;
}

export interface ReapedRun {
  runId: string;
  tenantId: string;
  lastHeartbeatAt?: string;
  startedAt: string;
  ageMs: number;
}

export interface ReaperResult {
  scanned: number;
  reaped: ReapedRun[];
  errors: { runId: string; message: string }[];
  // Wall-clock duration of this tick in milliseconds. Useful for spotting a
  // reaper that's drifting (a slow tick on a small store means the file
  // store is contended — and a contended store is the trigger for the
  // heartbeat/reap race we're guarding against). Captured by the caller so
  // it can be compared against pollIntervalMs.
  durationMs: number;
  // Per-tenant histogram of reaps for this tick. Empty when nothing was
  // reaped. A single tenant generating most of the reaps is a signal — that
  // tenant's loops are crashing, hitting OOM, or otherwise failing to write
  // heartbeats. Operators want to see this without grepping reaped[].
  reapedByTenant: Record<string, number>;
}

const DEFAULT_STALE_THRESHOLD_MS = 60_000;
const REAP_ERROR_TEXT = 'no heartbeat';
const REAP_HALT_REASON = 'reaper_stale_heartbeat';

export async function runReaperOnce(
  deps: ReaperDeps,
  opts: ReaperOptions = {},
): Promise<ReaperResult> {
  const threshold = opts.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const now = (opts.now ?? (() => new Date()))().getTime();
  // tickStart uses real time even when now() is mocked. Mocked now() is for
  // staleness math (deterministic threshold testing); durationMs is a
  // wall-clock observability signal that should reflect real I/O time.
  const tickStart = Date.now();
  // Watermark: any heartbeat with a timestamp <= this is stale. We pass this
  // through to reapIfStale so the store can re-check under its writeLock
  // whether the row's effective liveness timestamp has moved past staleAsOf
  // since our snapshot — that closes the heartbeat/reaper race (a queued
  // heartbeat write landing between our list() and the store's write).
  const staleAsOf = new Date(now - threshold).toISOString();

  const running = await deps.runs.list({ status: 'running' });
  const reaped: ReapedRun[] = [];
  const errors: { runId: string; message: string }[] = [];

  for (const row of running) {
    const ageMs = computeAgeMs(row, now);
    if (ageMs < threshold) continue;
    try {
      const closed = await deps.runs.reapIfStale(row.id, {
        staleAsOf,
        completion: {
          status: 'failed',
          errorText: REAP_ERROR_TEXT,
          haltReason: REAP_HALT_REASON,
        },
      });
      if (!closed) {
        // Either the loop closed the row first (status moved to terminal),
        // OR a fresh heartbeat landed between our list() and the store's
        // writeLock acquisition. Both outcomes are correct: don't kill a
        // live run. Skip silently — this is the expected race resolution.
        continue;
      }
      reaped.push({
        runId: row.id,
        tenantId: row.tenantId,
        lastHeartbeatAt: row.lastHeartbeatAt,
        startedAt: row.startedAt,
        ageMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ runId: row.id, message: msg });
    }
  }

  const reapedByTenant: Record<string, number> = {};
  for (const r of reaped) {
    reapedByTenant[r.tenantId] = (reapedByTenant[r.tenantId] ?? 0) + 1;
  }

  return {
    scanned: running.length,
    reaped,
    errors,
    durationMs: Date.now() - tickStart,
    reapedByTenant,
  };
}

function computeAgeMs(row: RunRecord, nowMs: number): number {
  // Prefer lastHeartbeatAt — it's the freshest liveness signal. Fall back to
  // startedAt for rows the loop never had a chance to heartbeat (process
  // died between runs.create() and the first step_started event).
  const reference = row.lastHeartbeatAt ?? row.startedAt;
  return nowMs - new Date(reference).getTime();
}

// Long-running poll loop. Returns a stop() handle for graceful shutdown.
// Intentionally a plain setInterval rather than a queue subscription — the
// reaper's job is liveness, so the SIMPLEST possible mechanism that runs
// independently of any other subsystem is the right one. No external deps
// beyond a working clock.
export interface ReaperHandle {
  stop: () => Promise<void>;
}

export function startReaper(
  deps: ReaperDeps,
  opts: ReaperOptions & {
    pollIntervalMs?: number;
    onResult?: (result: ReaperResult) => void;
  } = {},
): ReaperHandle {
  const pollInterval = opts.pollIntervalMs ?? 15_000;
  let running = false;
  let stopped = false;

  // Run once immediately so a startup sweep catches anything left over from
  // the previous process shift. Subsequent ticks fire every pollInterval.
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runReaperOnce(deps, opts);
      opts.onResult?.(result);
      // Structured tick line — emitted on EVERY tick (even silent ones).
      // A silent tick is a liveness signal for the reaper itself: if these
      // stop, something's wrong with the process, not with the runs. JSON
      // so a log scraper can pull durationMs / reapedByTenant cleanly.
      const tickEvent = {
        event: 'reaper_tick',
        scanned: result.scanned,
        reaped: result.reaped.length,
        errors: result.errors.length,
        durationMs: result.durationMs,
        reapedByTenant: result.reapedByTenant,
        ts: new Date().toISOString(),
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(tickEvent));
      // Errors still merit a high-visibility second line — JSON-parsed dashboards
      // are fine but a human tailing the log shouldn't have to decode bytes
      // to know something went wrong.
      if (result.errors.length > 0) {
        for (const e of result.errors) {
          // eslint-disable-next-line no-console
          console.error(`reaper: error on run ${e.runId}: ${e.message}`);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('reaper tick failed:', err);
    } finally {
      running = false;
    }
  };

  // Kick off the first sweep but DON'T await it — startReaper must be sync.
  void tick();
  const handle = setInterval(tick, pollInterval);

  return {
    async stop() {
      stopped = true;
      clearInterval(handle);
      // Wait for an in-flight tick to drain so callers know no further
      // writes will land after stop() resolves.
      while (running) {
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}
