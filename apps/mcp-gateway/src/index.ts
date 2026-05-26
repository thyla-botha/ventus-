import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';

// MCP gateway: per-tenant credential resolution, permission enforcement,
// PII scrubbing, audit. THIS COMPONENT IS HIGH-BLAST-RADIUS.
//
// Build-vs-buy decision is OPEN. Treat the scaffold below as the in-house
// shape; revisit before writing the credential vault and scrubber.
// See docs/decisions/0001-mcp-gateway-build-vs-buy.md (TBD).

const app = new Hono();

app.use('*', logger());

app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'mcp-gateway', ts: new Date().toISOString() }),
);

// Tool-call endpoint stub. Real impl will:
//  1. Authenticate the caller (agent runtime mTLS or signed token).
//  2. Resolve tenant_id from caller identity.
//  3. Check tenant's agents_enabled flag (kill switch).
//  4. Look up connector OAuth token (decrypt with tenant key, never log).
//  5. Run PII scrubber over payload pre-LLM (if outbound).
//  6. Forward to target MCP server (Gmail, Slack, Jira, etc.).
//  7. Record intent + outcome audit rows.
app.post('/v1/tool-call', async (c) => c.json({ error: 'not implemented' }, 501));

const port = Number(process.env.PORT ?? 8081);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`ventus mcp-gateway listening on :${info.port}`);
});
