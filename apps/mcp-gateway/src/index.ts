import { serve } from '@hono/node-server';
import { logger } from 'hono/logger';
import { FileCredentialStore } from '@ventus/credentials';
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

const app = createGatewayApp({ credentials, audit, forwarders });
app.use('*', logger());

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ventus mcp-gateway listening on :${info.port}`);
});
