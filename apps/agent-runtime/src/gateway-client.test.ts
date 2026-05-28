import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_AUTH_HEADERS, verifyGatewayRequest } from '@ventus/credentials';
import { GatewayClient, GatewayClientError } from './gateway-client.js';
import type { ToolContext } from './runtime.js';

// Gateway client unit tests. The fetchImpl is stubbed so these tests stay
// hermetic — no live gateway, no network. The signing path still goes
// through @ventus/credentials.signGatewayRequest so any drift between
// client signer and gateway verifier is caught here.

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const RUN_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

const CTX: ToolContext = { tenantId: TENANT_A, runId: RUN_ID, stepNo: 7 };

let priorSecret: string | undefined;

beforeEach(() => {
  priorSecret = process.env.VENTUS_MCP_GATEWAY_SECRET;
  process.env.VENTUS_MCP_GATEWAY_SECRET = randomBytes(48).toString('base64');
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.VENTUS_MCP_GATEWAY_SECRET;
  else process.env.VENTUS_MCP_GATEWAY_SECRET = priorSecret;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GatewayClient.call — happy path', () => {
  it('signs the request and returns the gateway data + intentId + scrub report', async () => {
    let capturedReq: Request | null = null;
    const client = new GatewayClient({
      baseUrl: 'http://gateway.test',
      tenantId: TENANT_A,
      fetchImpl: async (url, init) => {
        capturedReq = new Request(url, init);
        return jsonResponse(200, {
          ok: true,
          intentId: randomUUID(),
          data: { sent: true, id: 'abc' },
          scrub: { counts: { email: 1 }, redacted: true },
        });
      },
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });

    const result = await client.call('send_email', { to: 'jane@example.com' }, CTX);
    expect(result.data).toEqual({ sent: true, id: 'abc' });
    expect(result.scrub.redacted).toBe(true);

    // Verify the signature the client produced is accepted by the verifier
    // using the same secret. This is the round-trip contract test.
    expect(capturedReq).not.toBeNull();
    const req = capturedReq as unknown as Request;
    const body = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    const verified = verifyGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      body,
      headers,
    });
    expect(verified.tenantId).toBe(TENANT_A);
  });

  it('uses the remoteToolName when binding overrides it', async () => {
    let seenBody = '';
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async (_url, init) => {
        seenBody = String((init as RequestInit).body ?? '');
        return jsonResponse(200, {
          ok: true,
          intentId: randomUUID(),
          data: {},
          scrub: { counts: {}, redacted: false },
        });
      },
    });
    client.registerTool({
      toolName: 'send_email',
      connector: 'gmail',
      remoteToolName: 'messages.send',
    });
    await client.call('send_email', { to: 'x@y.com' }, CTX);
    const parsed = JSON.parse(seenBody) as { tool: string };
    expect(parsed.tool).toBe('messages.send');
  });

  it('forwards runId + stepNo from ToolContext into the body', async () => {
    let seenBody = '';
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async (_url, init) => {
        seenBody = String((init as RequestInit).body ?? '');
        return jsonResponse(200, {
          ok: true,
          intentId: randomUUID(),
          data: {},
          scrub: { counts: {}, redacted: false },
        });
      },
    });
    client.registerTool({ toolName: 'post_message', connector: 'slack' });
    await client.call('post_message', { channel: '#general' }, CTX);
    const parsed = JSON.parse(seenBody) as { runId: string; stepNo: number };
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.stepNo).toBe(7);
  });
});

describe('GatewayClient.call — failure modes', () => {
  it('throws GatewayClientError on 4xx with parsed body', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(412, { error: 'no credential for connector' }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    await expect(client.call('send_email', {}, CTX)).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 412,
      message: 'no credential for connector',
    });
  });

  it('throws GatewayClientError on 5xx', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(502, { error: 'forwarder failed' }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    await expect(client.call('send_email', {}, CTX)).rejects.toMatchObject({
      name: 'GatewayClientError',
      status: 502,
    });
  });

  it('throws when the response is non-JSON (proxy HTML, timeout page)', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () =>
        new Response('<html>Bad Gateway</html>', { status: 504 }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    await expect(client.call('send_email', {}, CTX)).rejects.toThrow(/non-JSON/);
  });

  it('throws on a malformed success body (no ok flag)', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(200, { unexpected: true }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    await expect(client.call('send_email', {}, CTX)).rejects.toThrow(/malformed success body/);
  });

  it('refuses to sign for a tenant other than the one it was constructed with', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(200, { ok: true, intentId: randomUUID(), data: {} }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    const otherCtx: ToolContext = { ...CTX, tenantId: TENANT_B };
    await expect(client.call('send_email', {}, otherCtx)).rejects.toThrow(
      /refused to sign for/,
    );
  });

  it('throws for an unregistered tool', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(200, { ok: true, intentId: randomUUID(), data: {} }),
    });
    await expect(client.call('unknown_tool', {}, CTX)).rejects.toThrow(
      /tool not registered/,
    );
  });
});

describe('GatewayClient.asExecutor', () => {
  it('returns just the gateway data payload (matches ToolExecutor contract)', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () =>
        jsonResponse(200, {
          ok: true,
          intentId: randomUUID(),
          data: { messageId: 'm-1' },
          scrub: { counts: {}, redacted: false },
        }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    const exec = client.asExecutor();
    const out = await exec('send_email', { to: 'x@y.com' }, CTX);
    expect(out).toEqual({ messageId: 'm-1' });
  });

  it('propagates errors as ToolExecutor failures (gateway 4xx)', async () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => jsonResponse(400, { error: 'invalid tool-call request' }),
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    const exec = client.asExecutor();
    await expect(exec('send_email', {}, CTX)).rejects.toThrow(/invalid tool-call request/);
  });
});

describe('GatewayClient construction', () => {
  it('rejects empty baseUrl', () => {
    expect(
      () =>
        new GatewayClient({
          baseUrl: '',
          tenantId: TENANT_A,
          fetchImpl: async () => new Response(''),
        }),
    ).toThrow(/baseUrl required/);
  });

  it('rejects empty tenantId', () => {
    expect(
      () =>
        new GatewayClient({
          baseUrl: 'http://g',
          tenantId: '',
          fetchImpl: async () => new Response(''),
        }),
    ).toThrow(/tenantId required/);
  });

  it('rejects a non-UUID tenantId (CODEX MEDIUM-8)', () => {
    expect(
      () =>
        new GatewayClient({
          baseUrl: 'http://g',
          tenantId: 'not-a-uuid',
          fetchImpl: async () => new Response(''),
        }),
    ).toThrow(/not a valid UUID/);
  });

  it('normalizes a mixed-case tenantId at construction (CODEX MEDIUM-8)', async () => {
    // The downstream vault and audit stores read tenantId as a raw string;
    // mixed-case partitions are a footgun. Constructing with uppercase
    // must produce a lowercase canonical form on the wire.
    const MIXED = '00000000-0000-0000-0000-00000000000A';
    let observedTenant: string | null = null;
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: MIXED,
      fetchImpl: async (_url, init) => {
        observedTenant =
          (init?.headers as Record<string, string>)['x-ventus-gateway-tenant'] ?? null;
        return jsonResponse(200, { ok: true, intentId: randomUUID(), data: {} });
      },
    });
    client.registerTool({ toolName: 'send_email', connector: 'gmail' });
    // Even if the caller's ToolContext also carries the uppercase form, the
    // client compares using lowercase normalization.
    await client.call('send_email', {}, { ...CTX, tenantId: MIXED });
    expect(observedTenant).toBe(MIXED.toLowerCase());
  });

  it('refuses duplicate tool registration', () => {
    const client = new GatewayClient({
      baseUrl: 'http://g',
      tenantId: TENANT_A,
      fetchImpl: async () => new Response(''),
    });
    client.registerTool({ toolName: 'x', connector: 'gmail' });
    expect(() => client.registerTool({ toolName: 'x', connector: 'slack' })).toThrow(
      /already registered/,
    );
  });
});
