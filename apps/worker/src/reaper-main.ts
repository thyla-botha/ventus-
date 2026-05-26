import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileRunStore } from '@ventus/store';
import { startReaper } from './reaper.js';

// Standalone reaper entry point. Run with `pnpm --filter @ventus/worker reaper:dev`.
// Reads the same env vars as the API so dev workflows share one .ventus/ dir
// without any extra wiring. Add to systemd / Fly's process model in prod.

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
