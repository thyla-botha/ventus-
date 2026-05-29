import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCredentialStore,
  GATEWAY_AUTH_HEADERS,
  signGatewayRequest,
} from '@ventus/credentials';
import { FileAuditStore } from '@ventus/store';
import { createGatewayApp } from './app.js';
import { EchoForwarder, ForwarderRegistry, type ForwardInput, type ToolForwarder } from './forwarder.js';

// MCP gateway end-to-end behaviour. The gateway is the only place where:
//   - per-tenant connector tokens are decrypted
//   - PII scrubbing happens pre-LLM
//   - audit-before-execute is enforced for agent tool calls
// Treat regressions here as release-blocking.

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

let dir: string;
let creds: FileCredentialStore;
let audit: FileAuditStore;
let priorMaster: string | undefined;
let priorSecret: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ventus-gateway-'));
  priorMaster = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  priorSecret = process.env.VENTUS_MCP_GATEWAY_SECRET;
  process.env.VENTUS_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
  process.env.VENTUS_MCP_GATEWAY_SECRET = randomBytes(48).toString('base64');
  creds = new FileCredentialStore(join(dir, 'credentials.json'));
  audit = new FileAuditStore(join(dir, 'audit.json'));
});

afterEach(async () => {
  if (priorMaster === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  else process.env.VENTUS_CREDENTIAL_MASTER_KEY = priorMaster;
  if (priorSecret === undefined) delete process.env.VENTUS_MCP_GATEWAY_SECRET;
  else process.env.VENTUS_MCP_GATEWAY_SECRET = priorSecret;
  await rm(dir, { recursive: true, force: true });
});

function makeApp(forwarder?: ToolForwarder) {
  const forwarders = new ForwarderRegistry().register(forwarder ?? new EchoForwarder('gmail'));
  return createGatewayApp({ credentials: creds, audit, forwarders });
}

async function signedFetch(
  app: ReturnType<typeof createGatewayApp>,
  tenantId: string,
  bodyObj: unknown,
): Promise<Response> {
  const body = JSON.stringify(bodyObj);
  const headers = signGatewayRequest({
    method: 'POST',
    path: '/v1/tool-call',
    tenantId,
    body,
  });
  return app.request('/v1/tool-call', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

describe('POST /v1/tool-call — happy path', () => {
  it('round-trips a signed tool call, scrubs PII, writes intent + outcome', async () => {
    await creds.set(TENANT_A, 'gmail', 'ya29.fake-gmail-token');
    const app = makeApp();
    const res = await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send_email',
      input: { to: 'jane@example.com', body: 'Call me at +1 415 555 1234' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: any; intentId: string; scrub: any };
    expect(json.ok).toBe(true);
    expect(json.intentId).toMatch(/^[0-9a-f-]{36}$/i);
    // Echo forwarder returned scrubbed input — PII is gone.
    expect(JSON.stringify(json.data)).toContain('[REDACTED:email]');
    expect(JSON.stringify(json.data)).toContain('[REDACTED:phone]');
    expect(JSON.stringify(json.data)).not.toContain('jane@example.com');
    expect(json.scrub.redacted).toBe(true);

    // Audit trail: 1 intent + 1 executed outcome.
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.intent.toolName).toBe('send_email');
    expect(trail[0]!.intent.resourceType).toBe('connector');
    expect(trail[0]!.intent.resourceId).toBe('gmail');
    expect(trail[0]!.outcome?.status).toBe('executed');
  });

  it('stored payload in the intent is SCRUBBED, never raw', async () => {
    // The audit intent persists the input as it appeared post-scrub. If a
    // future bug surfaced raw PII into audit rows, this test would catch it.
    await creds.set(TENANT_A, 'gmail', 'token');
    const app = makeApp();
    await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send',
      input: { email: 'leak@example.com' },
    });
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    const payload = trail[0]!.intent.payload as { email: string };
    expect(payload.email).toBe('[REDACTED:email]');
    expect(JSON.stringify(trail[0]!.intent.payload)).not.toContain('leak@example.com');
  });

  it('decrypts under the requesting tenant subkey (cross-tenant credential isolation)', async () => {
    // Tenant A and B both have a gmail token; A signs a request, must
    // receive A's credential to the forwarder, never B's.
    await creds.set(TENANT_A, 'gmail', 'tenant-A-token-marker');
    await creds.set(TENANT_B, 'gmail', 'tenant-B-token-marker');
    let seen: string | null = null;
    const captureForwarder: ToolForwarder = {
      connectorType: 'gmail',
      async forward(inp: ForwardInput) {
        seen = inp.credential;
        return { ok: true, data: { credential_marker: 'redacted-in-test' } };
      },
    };
    const app = makeApp(captureForwarder);
    await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send',
      input: {},
    });
    expect(seen).toBe('tenant-A-token-marker');
  });
});

describe('POST /v1/tool-call — auth failures', () => {
  it('returns 401 without HMAC headers', async () => {
    const app = makeApp();
    const res = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connector: 'gmail', tool: 'send', input: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when body is tampered after signing', async () => {
    const app = makeApp();
    const body = JSON.stringify({ connector: 'gmail', tool: 'send', input: { x: 1 } });
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    // Different body than the one signed.
    const tampered = JSON.stringify({ connector: 'gmail', tool: 'send', input: { x: 999 } });
    const res = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when tenant header is swapped (tenant smuggling)', async () => {
    const app = makeApp();
    const body = JSON.stringify({ connector: 'gmail', tool: 'send', input: {} });
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const smuggled = {
      ...headers,
      [GATEWAY_AUTH_HEADERS.tenant]: TENANT_B,
      'content-type': 'application/json',
    };
    const res = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: smuggled,
      body,
    });
    expect(res.status).toBe(401);
  });

  it('returns 403 when gateway secret is unset', async () => {
    // No app-side check; the verifier throws a 403 when secret is missing
    // because that is a config-time failure not a credential failure.
    delete process.env.VENTUS_MCP_GATEWAY_SECRET;
    const app = makeApp();
    const res = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [GATEWAY_AUTH_HEADERS.tenant]: TENANT_A,
        [GATEWAY_AUTH_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)),
        [GATEWAY_AUTH_HEADERS.nonce]: 'abc',
        [GATEWAY_AUTH_HEADERS.signature]: 'AA==',
      },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/tool-call — validation', () => {
  it('rejects an unknown connector with 400', async () => {
    const app = makeApp();
    const res = await signedFetch(app, TENANT_A, {
      connector: 'mystery-connector',
      tool: 'send',
      input: {},
    });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON with 400', async () => {
    const app = makeApp();
    const body = 'not json';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const res = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/tool-call — operational failures', () => {
  it('returns 412 and writes a failed outcome when no credential for connector', async () => {
    // No tenant credential row exists yet — the gateway must write the
    // intent BEFORE checking the vault, then a failed outcome. This is
    // the audit-before-execute invariant under the most common ops error.
    const app = makeApp();
    const res = await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send',
      input: {},
    });
    expect(res.status).toBe(412);
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.outcome?.status).toBe('failed');
    expect(trail[0]!.outcome?.errorText).toMatch(/no credential/);
  });

  it('returns 501 when no forwarder registered for connector', async () => {
    // Register only gmail; ask for slack.
    await creds.set(TENANT_A, 'slack', 'slack-token');
    const app = createGatewayApp({
      credentials: creds,
      audit,
      forwarders: new ForwarderRegistry().register(new EchoForwarder('gmail')),
    });
    const res = await signedFetch(app, TENANT_A, {
      connector: 'slack',
      tool: 'post_message',
      input: {},
    });
    expect(res.status).toBe(501);
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail[0]!.outcome?.status).toBe('failed');
    expect(trail[0]!.outcome?.errorText).toMatch(/no forwarder/);
  });

  it('returns 502 and writes a failed outcome when forwarder throws', async () => {
    await creds.set(TENANT_A, 'gmail', 'token');
    const erroringForwarder: ToolForwarder = {
      connectorType: 'gmail',
      async forward() {
        throw new Error('upstream Gmail 503');
      },
    };
    const app = makeApp(erroringForwarder);
    const res = await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send',
      input: {},
    });
    expect(res.status).toBe(502);
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail[0]!.outcome?.status).toBe('failed');
    expect(trail[0]!.outcome?.errorText).toBe('upstream Gmail 503');
  });
});

describe('POST /v1/tool-call — codex review fixes', () => {
  it('scrubs PII from the forwarder OUTPUT before audit + response (CODEX HIGH-2)', async () => {
    // Pre-fix bug: input was scrubbed but raw connector responses (Gmail
    // bodies, Slack messages) were written to audit AND returned to the
    // agent unredacted, then fed straight back into the next LLM prompt.
    // Set up a forwarder that emits PII in its DATA payload (independent
    // of input). The response and audit must both be redacted.
    await creds.set(TENANT_A, 'gmail', 'token');
    const piiEmittingForwarder: ToolForwarder = {
      connectorType: 'gmail',
      async forward() {
        return {
          ok: true,
          data: {
            messages: [
              {
                from: 'leaker@example.com',
                body: 'card: 4111 1111 1111 1111 phone: +1 415 555 9999',
              },
            ],
          },
        };
      },
    };
    const app = makeApp(piiEmittingForwarder);
    const res = await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'list_messages',
      input: {},
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown; scrub: { redacted: boolean } };
    const serialized = JSON.stringify(json.data);
    expect(serialized).not.toContain('leaker@example.com');
    expect(serialized).not.toContain('4111 1111 1111 1111');
    expect(serialized).not.toContain('+1 415 555 9999');
    expect(serialized).toContain('[REDACTED:email]');
    expect(serialized).toContain('[REDACTED:phone]');
    expect(json.scrub.redacted).toBe(true);

    // Audit outcome stores the scrubbed result too.
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(JSON.stringify(trail[0]!.outcome?.result)).not.toContain('leaker@example.com');
    expect(JSON.stringify(trail[0]!.outcome?.result)).toContain('[REDACTED:email]');
  });

  it('returns 500 (and never silently 200) when outcome write fails on success path (CODEX HIGH-4)', async () => {
    // Orphan-on-success-path invariant: a successful side effect followed
    // by a failed audit-outcome write must NOT be reported as 200 ok.
    // We monkey-patch the audit store to make recordOutcome throw only
    // on the SUCCESS path (status=executed). The intent and failed
    // recordOutcome writes remain functional.
    await creds.set(TENANT_A, 'gmail', 'token');
    const realRecord = audit.recordOutcome.bind(audit);
    audit.recordOutcome = async (input) => {
      if (input.status === 'executed') throw new Error('disk full');
      return realRecord(input);
    };
    try {
      const app = makeApp();
      const res = await signedFetch(app, TENANT_A, {
        connector: 'gmail',
        tool: 'send',
        input: { to: 'a@b.com' },
      });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe('audit_outcome_write_failed');
      // Intent is still on disk; reconciler will see an orphan.
      const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.outcome).toBeNull();
    } finally {
      audit.recordOutcome = realRecord;
    }
  });

  it('rejects a replayed signed request inside the skew window (CODEX HIGH-3)', async () => {
    // A captured signed request must not produce a second billable side
    // effect. We sign once, fire it twice — second call comes back 401.
    await creds.set(TENANT_A, 'gmail', 'token');
    const app = makeApp();
    const body = JSON.stringify({ connector: 'gmail', tool: 'send', input: { to: 'a@b.com' } });
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const first = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    const second = await app.request('/v1/tool-call', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body,
    });
    expect(second.status).toBe(401);
    const errBody = (await second.json()) as { error: string };
    expect(errBody.error).toMatch(/nonce already used/);
    // Audit must show ONLY the first call's intent + outcome — replay
    // must not double-write either.
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.outcome?.status).toBe('executed');
  });

  it('does NOT log raw OAuth tokens from forwarder errors to stdout (ship-blocker #1)', async () => {
    // Provider SDKs routinely embed Authorization: Bearer ya29... in
    // err.message. console.error fires before scrub would write that
    // verbatim to CloudWatch/Datadog — persistent storage in compliance
    // scope. The fix: scrub first, then log. The 'forwarder threw'
    // marker must remain so operators can still find the diagnostic.
    await creds.set(TENANT_A, 'gmail', 'token');
    const leakyForwarder: ToolForwarder = {
      connectorType: 'gmail',
      async forward() {
        throw new Error('gmail 401: Bearer ya29.STDOUT_LEAK_SECRET_xyz789 expired');
      },
    };
    const app = makeApp(leakyForwarder);
    const captured: string[] = [];
    const realConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    try {
      const res = await signedFetch(app, TENANT_A, {
        connector: 'gmail',
        tool: 'send',
        input: {},
      });
      expect(res.status).toBe(502);
      const joined = captured.join('\n');
      expect(joined).toContain('[mcp-gateway] forwarder threw:');
      expect(joined).not.toContain('ya29.STDOUT_LEAK_SECRET_xyz789');
    } finally {
      console.error = realConsoleError;
    }
  });

  it('does NOT leak forwarder error text to the response body (CODEX HIGH-6)', async () => {
    // Pre-fix bug: forwarder.message (e.g. "401 Unauthorized url=https://gmail.googleapis.com/... auth=Bearer ya29.SECRET")
    // was returned in the JSON response, which the agent loop appends as
    // a tool-result block on the next LLM call. We log the raw error
    // server-side and return only a generic 502.
    await creds.set(TENANT_A, 'gmail', 'token');
    const leakyForwarder: ToolForwarder = {
      connectorType: 'gmail',
      async forward() {
        throw new Error(
          'gmail 401: Bearer ya29.LEAKED_SECRET url=https://gmail.googleapis.com/?email=leak@x.com',
        );
      },
    };
    const app = makeApp(leakyForwarder);
    const res = await signedFetch(app, TENANT_A, {
      connector: 'gmail',
      tool: 'send',
      input: {},
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as Record<string, unknown>;
    // Response carries the generic shape only — no message, no token,
    // no URL, no email leak.
    expect(json.error).toBe('forwarder failed');
    expect(json.message).toBeUndefined();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('ya29.LEAKED_SECRET');
    expect(serialized).not.toContain('leak@x.com');
    expect(serialized).not.toContain('gmail.googleapis.com');

    // Audit row stores a SCRUBBED copy (PII redacted) — operators still
    // get the diagnostic without storing raw PII.
    const trail = await audit.listAuditTrail({ tenantId: TENANT_A });
    expect(trail[0]!.outcome?.status).toBe('failed');
    const auditedErr = trail[0]!.outcome?.errorText ?? '';
    expect(auditedErr).not.toContain('leak@x.com');
    expect(auditedErr).toContain('[REDACTED:email]');
  });
});

describe('GET /health', () => {
  it('responds 200 without any auth', async () => {
    const app = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; service: string };
    expect(json.status).toBe('ok');
    expect(json.service).toBe('mcp-gateway');
  });
});
