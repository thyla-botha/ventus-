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

// Boot-time auth gate. The dev shim (x-tenant-id/x-user-id headers under
// VENTUS_DEV_DEFAULT_TENANT=1) is a "trust the caller" path — fine for local
// dev and the test suite, but a footgun in production. This guard ensures a
// production deploy can never silently fall through to header trust:
// - VENTUS_REQUIRE_VERIFIED_AUTH=1 (explicit), OR
// - NODE_ENV=production (defensive default)
// requires SUPABASE_JWT_SECRET to be set OR dev defaults to be off.
const requireVerifiedAuth =
  process.env.VENTUS_REQUIRE_VERIFIED_AUTH === '1' ||
  process.env.NODE_ENV === 'production';
if (requireVerifiedAuth) {
  if (!process.env.SUPABASE_JWT_SECRET) {
    // eslint-disable-next-line no-console
    console.error(
      'refusing to start: verified auth is required but SUPABASE_JWT_SECRET is unset. ' +
        'Set the secret or unset VENTUS_REQUIRE_VERIFIED_AUTH / NODE_ENV=production.',
    );
    process.exit(1);
  }
  if (process.env.VENTUS_DEV_DEFAULT_TENANT === '1') {
    // eslint-disable-next-line no-console
    console.error(
      'refusing to start: VENTUS_DEV_DEFAULT_TENANT=1 disables JWT verification. ' +
        'Unset it in any environment that requires verified auth.',
    );
    process.exit(1);
  }
  // Sibling-environment JWT bleed gate. The Supabase JWT secret is shared
  // across every environment in the same Supabase project (preview, staging,
  // prod). Without an issuer pin, a valid JWT minted in preview verifies in
  // prod. SUPABASE_JWT_ISSUER must be set so the verifier rejects tokens
  // whose `iss` doesn't match this environment's project URL.
  if (!process.env.SUPABASE_JWT_ISSUER) {
    // eslint-disable-next-line no-console
    console.error(
      'refusing to start: verified auth is required but SUPABASE_JWT_ISSUER is unset. ' +
        'Pin the issuer (this env\'s Supabase project URL) to prevent sibling-env JWT bleed.',
    );
    process.exit(1);
  }
}

const app = createApp();
const port = Number(process.env.PORT ?? 8080);

// Boot-time pricing-coverage gate. VENTUS_REQUIRE_PRICED_MODELS=1 turns this
// from "warn on gaps" to "refuse to start on gaps" — operators flip the env
// flag once they've confirmed every model has an explicit entry in the
// pricing table. Reason: an unpriced model falls through to the safety
// fallback, which silently miscalibrates the cost ceiling (the ceiling
// becomes a fiction). For regulated/billed tenants the gate is the
// difference between "the ceiling holds" and "the ceiling looks like it
// holds". We always *log* the report at boot so the same data is in the
// startup logs even when the gate is off.
await getAppState()
  .getPricingCoverageReport()
  .then((report) => {
    if (report.ok) {
      // eslint-disable-next-line no-console
      console.log(`pricing coverage ok: ${report.entries.length} entries, all priced`);
      return;
    }
    const unpriced = report.entries.filter((e) => !e.priced);
    const lines = unpriced.map(
      (e) =>
        `  - ${e.source}=${e.identifier} model=${e.model}${e.provider ? ` provider=${e.provider}` : ''}`,
    );
    const summary = `pricing coverage incomplete: ${report.unpricedCount} unpriced of ${report.entries.length}\n${lines.join('\n')}`;
    if (process.env.VENTUS_REQUIRE_PRICED_MODELS === '1') {
      // eslint-disable-next-line no-console
      console.error(
        `${summary}\nVENTUS_REQUIRE_PRICED_MODELS=1; refusing to start. ` +
          `Register pricing via registerModelPricing() at boot or unset the flag.`,
      );
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn(`${summary}\n(set VENTUS_REQUIRE_PRICED_MODELS=1 to fail fast)`);
  })
  .catch((err) => {
    // A failure here means we couldn't even *load* the skill catalog or
    // the tenant profile store. With the require flag off this is an
    // init-time bug worth surfacing loudly but not a startup blocker —
    // the same failure resurfaces from the route handler with a cleaner
    // stack trace. With the flag ON, however, the operator has explicitly
    // asked us to fail-closed on coverage gaps. Coverage UNKNOWN is at
    // least as bad as coverage incomplete, so we honour the same exit
    // contract here. Codex round-10 P2.
    // eslint-disable-next-line no-console
    console.error('pricing coverage report failed at boot:', err);
    if (process.env.VENTUS_REQUIRE_PRICED_MODELS === '1') {
      // eslint-disable-next-line no-console
      console.error(
        'VENTUS_REQUIRE_PRICED_MODELS=1; refusing to start because pricing ' +
          'coverage could not be verified (skill catalog or tenant profile ' +
          'store unreadable). Fix the underlying read error or unset the flag.',
      );
      process.exit(1);
    }
  });

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
