import { serve } from '@hono/node-server';
import { startReaper } from '@ventus/worker/reaper';
import { createApp } from './app.js';
import { getAppState } from './state.js';

// The reaper runs INSIDE the API process so heartbeat writes and reap writes
// share the same in-process writeLock on the FileRunStore — that's what makes
// reapIfStale's compare-and-set actually atomic. Running it as a separate
// process (apps/worker/src/reaper-main.ts) reopens the heartbeat/reaper race
// because the two processes hold independent in-memory locks on the same
// JSON file. reaper-main.ts is preserved as an advanced opt-in (gated by
// VENTUS_REAPER_STANDALONE=1) for testing the reaper in isolation; production
// should rely on this in-process instance.
//
// Knobs share env vars with reaper-main so the dev story stays consistent.
const STALE_MS = parseEnvNumber('VENTUS_REAPER_STALE_MS', 60_000);
const POLL_MS = parseEnvNumber('VENTUS_REAPER_POLL_MS', 15_000);

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const app = createApp();
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ventus api listening on :${info.port}`);
});

// Bind the reaper to the same RunStore the routes use, not a fresh one — a
// second FileRunStore instance would re-create the per-instance writeLock
// problem (two in-memory locks, one file).
const reaperHandle = startReaper(
  { runs: getAppState().runs },
  { staleThresholdMs: STALE_MS, pollIntervalMs: POLL_MS },
);

// Idempotent shutdown. SIGINT and SIGTERM can both fire (e.g. Ctrl-C followed
// by a supervisor SIGTERM). Without the latch we'd re-await server.close on
// an already-closing server and double-call reaperHandle.stop. Also crucial
// during tests/process managers that send multiple signals in a graceful
// shutdown window.
let shuttingDown: Promise<void> | null = null;

const shutdown = (signal: string): Promise<void> => {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    // eslint-disable-next-line no-console
    console.log(`ventus api: received ${signal}, draining`);
    // Step 1: stop accepting new connections. AWAIT the close — the @hono/node-server
    // serve() returns the underlying Node http.Server, whose close() callback
    // only fires once all in-flight requests have settled. Skipping the await
    // means process.exit could cut active responses mid-write and skip
    // drainInflight's snapshot for late arrivals.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    // Step 2: stop the reaper. Its own stop() drains an in-flight tick before
    // resolving, so no further reap-writes land after this awaits.
    await reaperHandle.stop();
    // Step 3: drain any agent loops that the now-closed server kicked off
    // before close. drainInflight settles each tracked loop to its terminal
    // Run row, so no orphan 'running' rows leak across the restart.
    await getAppState().drainInflight();
    // eslint-disable-next-line no-console
    console.log('ventus api: shutdown complete');
    process.exit(0);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('ventus api: shutdown failed', err);
    process.exit(1);
  });
  return shuttingDown;
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { createApp } from './app.js';
export type { AppType } from './app.js';
