import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import {
  FileCredentialStore,
  InMemoryNonceStore,
  PostgresCredentialStore,
  type CredentialStore,
  type PgTenantRunner,
} from '@ventus/credentials';
import { withTenant } from '@ventus/db';
import {
  FileAuditStore,
  PostgresAuditStore,
  type AuditStore,
  type PgQuerier,
  type PgTenantRunner as StorePgTenantRunner,
} from '@ventus/store';
import { createGatewayApp } from './app.js';
import { EchoForwarder, ForwarderRegistry } from './forwarder.js';
import {
  GmailForwarder,
  GoogleApiGmailClient,
  GoogleOAuthRefresher,
} from './forwarders/gmail.js';

// MCP gateway entry. Boots HTTP server with file-backed stores in dev and
// in production. Per the security contract:
//   - VENTUS_MCP_GATEWAY_SECRET must be set (HMAC over agent→gateway calls).
//   - VENTUS_CREDENTIAL_MASTER_KEY must be set (per-tenant subkey derivation).
//   - In production, both env vars are HARD-required; failure to set them
//     exits non-zero before the listener binds.
//
// Storage paths live under VENTUS_GATEWAY_STATE_DIR (default ./.gateway-state)
// so the gateway process can run isolated from the API process's vault.
// Same backing file across processes works, but it MUST be the same path on
// disk — the lock chain is per-instance.

const isProd = process.env.NODE_ENV === 'production';

if (!process.env.VENTUS_MCP_GATEWAY_SECRET) {
  if (isProd) {
    // eslint-disable-next-line no-console
    console.error('FATAL: VENTUS_MCP_GATEWAY_SECRET not set in production');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn('WARN: VENTUS_MCP_GATEWAY_SECRET not set — tool-call POSTs will 403');
}

if (!process.env.VENTUS_CREDENTIAL_MASTER_KEY) {
  if (isProd) {
    // eslint-disable-next-line no-console
    console.error('FATAL: VENTUS_CREDENTIAL_MASTER_KEY not set in production');
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn('WARN: VENTUS_CREDENTIAL_MASTER_KEY not set — vault decrypt will fail');
}

const stateDir = process.env.VENTUS_GATEWAY_STATE_DIR ?? '.gateway-state';
// Credential storage: Postgres in production (DATABASE_URL set), file in
// dev. Same switch as apps/api so a credential PUT through the API is
// visible to a tool-call POST through the gateway when both processes
// point at the same DB.
const credentials: CredentialStore = process.env.DATABASE_URL
  ? new PostgresCredentialStore({
      withTenant: (ctx, fn) =>
        withTenant(ctx, (sql) => fn(sql as unknown as Parameters<typeof fn>[0])),
    } satisfies PgTenantRunner)
  : new FileCredentialStore(`${stateDir}/credentials.json`);
// Audit storage: Postgres when DATABASE_URL is set so a tool-call POST
// through the gateway writes intent/outcome rows to the same store the API
// reads from. File otherwise. Matches the credentials swap above.
const audit: AuditStore = process.env.DATABASE_URL
  ? new PostgresAuditStore({
      withTenant: (ctx, fn) =>
        withTenant(ctx, (sql) => fn(sql as unknown as PgQuerier)),
    } satisfies StorePgTenantRunner)
  : new FileAuditStore(`${stateDir}/audit.json`);
// Gmail forwarder is real only when OAuth client envs are wired. Without
// them we fall back to EchoForwarder so the gateway still boots in dev and
// the tool surface stays consistent — calls just stub out instead of
// hitting Google. PR 5 ships the onboarding flow that populates these.
const gmailForwarder = process.env.GOOGLE_CLIENT_ID
  ? new GmailForwarder({
      credentials,
      client: new GoogleApiGmailClient(),
      refresher: new GoogleOAuthRefresher(),
    })
  : new EchoForwarder('gmail');

const forwarders = new ForwarderRegistry()
  .register(gmailForwarder)
  .register(new EchoForwarder('gdrive'))
  .register(new EchoForwarder('slack'))
  .register(new EchoForwarder('jira'))
  .register(new EchoForwarder('clickup'))
  .register(new EchoForwarder('whatsapp'));

// Nonce store wiring. The lazy purge in InMemoryNonceStore.has() is
// effectively unreachable in production: nonces are randomBytes(16) so
// the same key is never re-queried, and stale rows accumulate until OOM.
// We schedule an explicit sweep here and gate prod boot to single-replica
// only — multi-replica deployments share no Map and would let an attacker
// replay a verified request through a sibling process.
if (isProd && process.env.VENTUS_MCP_GATEWAY_SINGLE_REPLICA !== 'true') {
  // eslint-disable-next-line no-console
  console.error(
    'FATAL: in-memory nonce store requires VENTUS_MCP_GATEWAY_SINGLE_REPLICA=true in production. ' +
      'Multi-replica deployments need a shared store (Redis/DB-backed) — wire one via createGatewayApp({ nonceStore }).',
  );
  process.exit(1);
}

const nonceStore = new InMemoryNonceStore();
const NONCE_SWEEP_INTERVAL_MS = 30_000;
const nonceSweep = setInterval(() => {
  nonceStore.purgeExpired(Math.floor(Date.now() / 1000));
}, NONCE_SWEEP_INTERVAL_MS);
nonceSweep.unref();

// eslint-disable-next-line no-console
console.log(
  '[mcp-gateway] nonce backend: in-memory (single-replica). ' +
    'For multi-replica deployments, supply a shared nonceStore.',
);

const app = createGatewayApp({ credentials, audit, forwarders, nonceStore });
app.use('*', logger());

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ventus mcp-gateway listening on :${info.port}`);
});
