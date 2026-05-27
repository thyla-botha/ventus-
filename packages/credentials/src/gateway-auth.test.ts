import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_AUTH_HEADERS,
  GatewayAuthError,
  signGatewayRequest,
  verifyGatewayRequest,
} from './gateway-auth.js';

// Agent-runtime → MCP gateway HMAC boundary. These tests are the security
// contract for every internal tool call; treat regressions as release-blocking.

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

let priorSecret: string | undefined;

beforeEach(() => {
  priorSecret = process.env.VENTUS_MCP_GATEWAY_SECRET;
  process.env.VENTUS_MCP_GATEWAY_SECRET = randomBytes(48).toString('base64');
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.VENTUS_MCP_GATEWAY_SECRET;
  else process.env.VENTUS_MCP_GATEWAY_SECRET = priorSecret;
});

describe('signGatewayRequest + verifyGatewayRequest', () => {
  it('round-trips a signed request under the same secret', () => {
    const body = JSON.stringify({ tool: 'list_recent_documents', input: { source_type: 'email' } });
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const result = verifyGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      body,
      headers,
    });
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.nonce).toBe(headers[GATEWAY_AUTH_HEADERS.nonce]);
  });

  it('rejects a tampered body (hash mismatch)', () => {
    const body = JSON.stringify({ tool: 'send_email', input: { to: 'jane@example.com' } });
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const tampered = JSON.stringify({ tool: 'send_email', input: { to: 'attacker@evil.com' } });
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body: tampered,
        headers,
      }),
    ).toThrow(GatewayAuthError);
  });

  it('rejects a tenant-smuggled header (signer signed for A, header says B)', () => {
    // Attacker grabs a valid signature for tenant A and swaps the tenant
    // header to B. The signature was bound to A in the canonical string,
    // so it must fail to verify under B.
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const smuggled = { ...headers, [GATEWAY_AUTH_HEADERS.tenant]: TENANT_B };
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers: smuggled,
      }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a stale timestamp (replay outside skew window)', () => {
    const body = '{}';
    // Sign at t=1000, verify at t=2000 (1000s later, well outside 60s skew).
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
      timestamp: 1000,
    });
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
        now: () => 2000,
      }),
    ).toThrow(/skew window/);
  });

  it('accepts a timestamp within the skew window', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
      timestamp: 1000,
    });
    // 30s later — well inside the 60s window.
    const result = verifyGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      body,
      headers,
      now: () => 1030,
    });
    expect(result.tenantId).toBe(TENANT_A);
  });

  it('rejects a future timestamp outside the skew window', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
      timestamp: 5000,
    });
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
        now: () => 1000,
      }),
    ).toThrow(/skew window/);
  });

  it('rejects when any required header is missing', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const noSig = { ...headers };
    delete (noSig as Record<string, string | undefined>)[GATEWAY_AUTH_HEADERS.signature];
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers: noSig,
      }),
    ).toThrow(/missing gateway auth headers/);
  });

  it('rejects a malformed (non-numeric) timestamp', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const bad = { ...headers, [GATEWAY_AUTH_HEADERS.timestamp]: 'not-a-number' };
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers: bad,
      }),
    ).toThrow(/invalid timestamp/);
  });

  it('rejects a signature signed under a different secret', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    // Rotate the secret — same headers, different verifier secret.
    process.env.VENTUS_MCP_GATEWAY_SECRET = randomBytes(48).toString('base64');
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
      }),
    ).toThrow(/signature mismatch/);
  });

  it('refuses to sign when the secret is unset', () => {
    delete process.env.VENTUS_MCP_GATEWAY_SECRET;
    expect(() =>
      signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body: '{}',
      }),
    ).toThrow(/VENTUS_MCP_GATEWAY_SECRET not configured/);
  });

  it('refuses to sign when the secret is too short', () => {
    process.env.VENTUS_MCP_GATEWAY_SECRET = 'too-short';
    expect(() =>
      signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body: '{}',
      }),
    ).toThrow(/must be at least/);
  });

  it('rejects a path swap (same body + tenant + ts, different path)', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    expect(() =>
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/some-other-path',
        body,
        headers,
      }),
    ).toThrow(/signature mismatch/);
  });

  it('rejects a method swap (POST signed, GET attempted)', () => {
    const body = '{}';
    const headers = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    expect(() =>
      verifyGatewayRequest({
        method: 'GET',
        path: '/v1/tool-call',
        body,
        headers,
      }),
    ).toThrow(/signature mismatch/);
  });

  it('verifies via a Headers-like .get() shim (Hono request shape)', () => {
    const body = '{}';
    const signed = signGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      tenantId: TENANT_A,
      body,
    });
    const map = new Map(Object.entries(signed));
    const shim = { get(name: string): string | null {
      return map.get(name) ?? null;
    }};
    const result = verifyGatewayRequest({
      method: 'POST',
      path: '/v1/tool-call',
      body,
      headers: shim,
    });
    expect(result.tenantId).toBe(TENANT_A);
  });
});
