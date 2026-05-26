import { serve } from '@hono/node-server';
import { startReaper } from '@ventus/worker/reaper';
import { createApp } from './app.js';
import { getAppState } from './state.js';

// The reaper runs INSIDE the API process so heartbeat writes and reap writes
// share the same in-process writeLock on the FileRunStore — that's what makes
// reapIfStale's compare-and-set actually atomic. Running it as a separate
// process (apps/worker/src/reaper-main.ts) reopens the heartbeat/reaper race
// because the two processes hold independent in-memory locks on the same
// JSON file. reaper-main.ts is preserved as an advanced opt-in for testing
// the reaper in isolation, but production should rely on this in-process
// instance.
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

const shutdown = async (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`ventus api: received ${signal}, draining`);
  // Stop accepting new connections first so drainInflight sees a stable set
  // of in-flight loops.
  server.close();
  await reaperHandle.stop();
  await getAppState().drainInflight();
  // eslint-disable-next-line no-console
  console.log('ventus api: shutdown complete');
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

export { createApp } from './app.js';
export type { AppType } from './app.js';
