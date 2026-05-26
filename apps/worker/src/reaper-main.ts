import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileRunStore } from '@ventus/store';
import { startReaper } from './reaper.js';

// Standalone reaper entry point — ADVANCED OPT-IN ONLY.
//
// The API process (apps/api/src/index.ts) starts an in-process reaper by
// default. That is the correct mode: heartbeat writes and reap writes share
// the same FileRunStore writeLock, which is what makes reapIfStale's
// compare-and-set actually atomic.
//
// Running this file alongside the API on the SAME file store reopens the
// heartbeat/reaper race because the two processes hold independent in-memory
// locks on the same JSON file (last-writer-wins on the on-disk row). DO NOT
// run both pointing at the same VENTUS_RUN_STORE.
//
// Legitimate uses for this entrypoint:
//   - Testing the reaper in isolation against a private VENTUS_RUN_STORE path
//   - Future Postgres deployment where atomicity moves to the database
//     (single conditional UPDATE) and the API no longer needs to host the
//     reaper. At that point, drop the API's startReaper() call and run this
//     as a sidecar.

function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// Fail-closed guard: this entrypoint reopens the heartbeat/reaper race when
// run alongside the API on the same VENTUS_RUN_STORE (see the header
// comment). Require explicit opt-in so accidental invocation by a process
// supervisor or muscle memory crashes loudly rather than silently corrupting
// liveness state. The lockfile we'd ideally take here is deferred — the env
// gate is the cheap, sufficient mitigation.
if (process.env.VENTUS_REAPER_STANDALONE !== '1') {
  // eslint-disable-next-line no-console
  console.error(
    'reaper-main: refusing to start. The API process now runs the reaper in-process; running this entrypoint against the same VENTUS_RUN_STORE will reopen the heartbeat/reaper race.\n' +
      '\n' +
      'If you genuinely need the standalone reaper (e.g. isolation testing against a private run-store path), set VENTUS_REAPER_STANDALONE=1.',
  );
  process.exit(2);
}

const ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
const RUN_STORE_PATH = process.env.VENTUS_RUN_STORE
  ? resolve(process.env.VENTUS_RUN_STORE)
  : resolve(ROOT, '.ventus/runs.json');

// Knobs: both numbers parse cleanly via Number(undefined) === NaN; we
// fall back to the module defaults when env is absent or malformed.
const STALE_MS = parseEnvNumber('VENTUS_REAPER_STALE_MS', 60_000);
const POLL_MS = parseEnvNumber('VENTUS_REAPER_POLL_MS', 15_000);

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const runs = new FileRunStore(RUN_STORE_PATH);

// eslint-disable-next-line no-console
console.log(
  `reaper-main: starting (store=${RUN_STORE_PATH}, stale=${STALE_MS}ms, poll=${POLL_MS}ms)`,
);

const handle = startReaper(
  { runs },
  { staleThresholdMs: STALE_MS, pollIntervalMs: POLL_MS },
);

const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log('reaper-main: shutting down');
  await handle.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
