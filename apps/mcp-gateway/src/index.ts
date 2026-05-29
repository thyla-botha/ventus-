import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { FileCredentialStore, InMemoryNonceStore } from '@ventus/credentials';
import { FileAuditStore } from '@ventus/store';
import { createGatewayApp } from './app.js';
import { EchoForwarder, ForwarderRegistry } from './forwarder.js';

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
const credentials = new FileCredentialStore(`${stateDir}/credentials.json`);
const audit = new FileAuditStore(`${stateDir}/audit.json`);
const forwarders = new ForwarderRegistry()
  .register(new EchoForwarder('gmail'))
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
