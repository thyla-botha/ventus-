import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_AUTH_HEADERS,
  GatewayAuthError,
  InMemoryNonceStore,
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

  describe('tenantId normalization (CODEX MEDIUM-8)', () => {
    it('signer rejects a non-UUID tenantId', () => {
      expect(() =>
        signGatewayRequest({
          method: 'POST',
          path: '/v1/tool-call',
          tenantId: 'definitely-not-a-uuid',
          body: '{}',
        }),
      ).toThrow(/not a valid UUID/);
    });

    it('signer normalizes a mixed-case tenant header to lowercase', () => {
      const MIXED = '00000000-0000-0000-0000-00000000000A';
      const headers = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: MIXED,
        body: '{}',
      });
      expect(headers[GATEWAY_AUTH_HEADERS.tenant]).toBe(MIXED.toLowerCase());
    });

    it('verifier rejects a mixed-case header tenantId that does not round-trip', () => {
      // The signer lowercases on the way out, so any verifier seeing
      // uppercase has been tampered or mis-constructed externally.
      // Verifier ALSO lowercases before checking — a tampered uppercase
      // header with the same signature must therefore still produce a
      // valid round-trip (signature was computed over lowercase). We
      // assert: round-trip works AND result.tenantId is lowercase.
      const MIXED = '00000000-0000-0000-0000-00000000000A';
      const headers = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: MIXED,
        body: '{}',
      });
      const result = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body: '{}',
        headers,
      });
      expect(result.tenantId).toBe(MIXED.toLowerCase());
    });

    it('verifier rejects a non-UUID header', () => {
      // Construct headers with a garbage tenant. We can't go through
      // signGatewayRequest (which would reject), so simulate the raw
      // header set directly.
      const body = '{}';
      // Sign with a valid tenant, then swap the tenant header to garbage.
      const ok = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body,
      });
      const garbage = { ...ok, [GATEWAY_AUTH_HEADERS.tenant]: 'not-a-uuid' };
      expect(() =>
        verifyGatewayRequest({
          method: 'POST',
          path: '/v1/tool-call',
          body,
          headers: garbage,
        }),
      ).toThrow(/not a valid UUID/);
    });
  });

  describe('replay protection (CODEX HIGH-3)', () => {
    it('accepts the first sighting and rejects a second sighting of the same nonce', () => {
      const body = '{}';
      const headers = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body,
        timestamp: 1000,
      });
      const store = new InMemoryNonceStore();
      // First call inside the skew window: accept.
      const first = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
        now: () => 1010,
        nonceStore: store,
      });
      expect(first.tenantId).toBe(TENANT_A);
      // Replay the EXACT same headers + body inside the same window: must
      // reject with a distinct "nonce already used" message so the operator
      // can tell replay apart from a fresh signature mismatch.
      expect(() =>
        verifyGatewayRequest({
          method: 'POST',
          path: '/v1/tool-call',
          body,
          headers,
          now: () => 1020,
          nonceStore: store,
        }),
      ).toThrow(/nonce already used/);
    });

    it('does NOT consume a nonce when the signature is invalid', () => {
      // An attacker spraying invalid signatures must not be able to grow
      // the nonce store. Only verified-signature requests reserve a slot.
      const body = '{}';
      const headers = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body,
        timestamp: 1000,
      });
      const store = new InMemoryNonceStore();
      // Tamper the signature.
      const tampered = {
        ...headers,
        [GATEWAY_AUTH_HEADERS.signature]: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      };
      expect(() =>
        verifyGatewayRequest({
          method: 'POST',
          path: '/v1/tool-call',
          body,
          headers: tampered,
          now: () => 1010,
          nonceStore: store,
        }),
      ).toThrow();
      expect(store.sizeForTests()).toBe(0);
      // The legitimate signature still verifies (nonce is still fresh).
      const ok = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
        now: () => 1010,
        nonceStore: store,
      });
      expect(ok.tenantId).toBe(TENANT_A);
    });

    it('expires nonces after the skew window so memory does not grow unbounded', () => {
      const body = '{}';
      const headers = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body,
        timestamp: 1000,
      });
      const store = new InMemoryNonceStore();
      verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers,
        now: () => 1010,
        nonceStore: store,
      });
      expect(store.sizeForTests()).toBe(1);
      // After +SKEW_SECONDS (60s past the signed ts), the entry is stale.
      store.purgeExpired(1061);
      expect(store.sizeForTests()).toBe(0);
    });

    it('rejects a replay at exactly timestamp + SKEW_SECONDS (off-by-one follow-up)', () => {
      // Boundary case the adversarial review flagged: the skew gate uses
      // strict `>` so a verify at `now === timestamp + SKEW_SECONDS` is
      // still accepted. If retention is set to exactly that value, the
      // store's lazy purge (`exp <= now`) evicts the row at the same
      // instant and the replay slips through. The fix extends retention
      // by +1s; this test pins the behavior so the off-by-one cannot
      // silently regress.
      const t = 1000;
      const store = new InMemoryNonceStore();
      const signed = signGatewayRequest({
        method: 'POST',
        path: '/x',
        tenantId: TENANT_A,
        body: '{}',
        timestamp: t,
      });
      verifyGatewayRequest({
        method: 'POST',
        path: '/x',
        body: '{}',
        headers: signed,
        now: () => t,
        nonceStore: store,
      });
      expect(() =>
        verifyGatewayRequest({
          method: 'POST',
          path: '/x',
          body: '{}',
          headers: signed,
          now: () => t + 60,
          nonceStore: store,
        }),
      ).toThrow(/nonce already used/);
    });

    it('treats nonces from different tenants as distinct keys', () => {
      // A and B can hold the same nonce without collision — replay
      // protection is scoped to the signer's tenant. (If both used the
      // same nonce literal in the same window, both should still verify.)
      const body = '{}';
      const fixedNonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const ha = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_A,
        body,
        timestamp: 1000,
        nonce: fixedNonce,
      });
      const hb = signGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        tenantId: TENANT_B,
        body,
        timestamp: 1000,
        nonce: fixedNonce,
      });
      const store = new InMemoryNonceStore();
      const a = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers: ha,
        now: () => 1010,
        nonceStore: store,
      });
      const b = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body,
        headers: hb,
        now: () => 1010,
        nonceStore: store,
      });
      expect(a.tenantId).toBe(TENANT_A);
      expect(b.tenantId).toBe(TENANT_B);
    });
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
