// Agent-runtime → MCP gateway auth boundary.
//
// The gateway holds per-tenant OAuth tokens, the PII scrubber, and the
// audit-before-execute pen. Anything that can call POST /v1/tool-call can
// (a) trigger billable connector traffic, (b) cause an audit_intent row to
// be written under an arbitrary tenant. Strong authentication on this hop
// is non-negotiable.
//
// Design choice: HMAC-SHA256 over a canonical request rather than mTLS or
// JWT. Reasons:
//   - mTLS needs cert lifecycle infra we don't yet have; HMAC works with
//     a single shared secret in env.
//   - A short-lived JWT signed by an oracle adds an extra service to the
//     hot path. HMAC over the request itself binds tenant + body + time
//     in one shot.
//   - The agent runtime and the gateway are co-located workloads inside
//     the same trust boundary today. The HMAC is here to defend against
//     two threats: (1) a misconfigured caller within our cluster sending
//     to the wrong tenant; (2) any future internet exposure of the
//     gateway endpoint.
//
// Threat model:
//   - Replay outside ±SKEW_SECONDS window: REJECTED via timestamp.
//   - Body tamper after sign: REJECTED via body-hash binding.
//   - Tenant smuggling (body says tenant A, signer signed for tenant B):
//     REJECTED because tenantId is part of the canonical signing string.
//   - Secret theft: out of scope here; relies on env-var hygiene + boot
//     gates in apps/mcp-gateway/src/index.ts and apps/agent-runtime.
//
// What this does NOT do:
//   - It does NOT authenticate the END USER; that is jwt-verify.ts on
//     the API edge. The gateway boundary is internal: agent runtime
//     authenticating to the gateway as the platform service.
//   - It does NOT replace per-tenant credential decryption inside the
//     gateway. Even with a valid HMAC, the gateway still decrypts the
//     connector token under the requested tenant's subkey, which fails
//     closed if the requested tenant has no row.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SECRET_ENV = 'VENTUS_MCP_GATEWAY_SECRET';
const HEADER_TENANT = 'x-ventus-gateway-tenant';
const HEADER_TIMESTAMP = 'x-ventus-gateway-timestamp';
const HEADER_NONCE = 'x-ventus-gateway-nonce';
const HEADER_SIGNATURE = 'x-ventus-gateway-signature';

// Allowed clock skew between signer and verifier. 60s mirrors the OAuth
// JWT industry default; tight enough to bound replay windows, loose
// enough to survive normal NTP drift.
const SKEW_SECONDS = 60;

// Minimum secret length. Anything shorter is a config smell — likely a
// placeholder or a dev-mode leftover. The boot gate in mcp-gateway will
// refuse to start under those.
const MIN_SECRET_LEN = 32;

export class GatewayAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 = 401) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

export interface SignedHeaders extends Record<string, string> {
  [HEADER_TENANT]: string;
  [HEADER_TIMESTAMP]: string;
  [HEADER_NONCE]: string;
  [HEADER_SIGNATURE]: string;
}

export interface SignInput {
  method: string;
  path: string;
  tenantId: string;
  body: string;
  // Optional overrides for tests; defaults are randomBytes + Date.now.
  nonce?: string;
  timestamp?: number;
}

export interface VerifyInput {
  method: string;
  path: string;
  body: string;
  // Headers in lowercase key form (Hono normalises). The verifier accepts
  // either a Record or a Headers-like object via .get().
  headers: Record<string, string | undefined> | { get(name: string): string | null };
  // Test seam — defaults to Date.now()/1000.
  now?: () => number;
}

// Canonical signing string. Newline-joined to prevent field-boundary
// ambiguity (a request that smuggled '\n' into a single field would be
// hashed differently, which is exactly what we want).
function canonicalString(
  method: string,
  path: string,
  tenantId: string,
  timestamp: number,
  nonce: string,
  bodyHash: string,
): string {
  return [method.toUpperCase(), path, tenantId, String(timestamp), nonce, bodyHash].join('\n');
}

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function getSecret(): Buffer {
  const raw = process.env[SECRET_ENV];
  if (!raw || raw.length < MIN_SECRET_LEN) {
    throw new GatewayAuthError(
      `${SECRET_ENV} not configured (must be at least ${MIN_SECRET_LEN} chars)`,
      403,
    );
  }
  return Buffer.from(raw, 'utf8');
}

export function signGatewayRequest(input: SignInput): SignedHeaders {
  const secret = getSecret();
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const bodyHash = hashBody(input.body);
  const canonical = canonicalString(
    input.method,
    input.path,
    input.tenantId,
    timestamp,
    nonce,
    bodyHash,
  );
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('base64');
  return {
    [HEADER_TENANT]: input.tenantId,
    [HEADER_TIMESTAMP]: String(timestamp),
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: signature,
  };
}

function readHeader(
  headers: VerifyInput['headers'],
  name: string,
): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(n: string): string | null }).get(name);
    return v ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()];
}

export interface VerifiedRequest {
  tenantId: string;
  timestamp: number;
  nonce: string;
}

export function verifyGatewayRequest(input: VerifyInput): VerifiedRequest {
  const tenantId = readHeader(input.headers, HEADER_TENANT);
  const timestampStr = readHeader(input.headers, HEADER_TIMESTAMP);
  const nonce = readHeader(input.headers, HEADER_NONCE);
  const signature = readHeader(input.headers, HEADER_SIGNATURE);
  if (!tenantId || !timestampStr || !nonce || !signature) {
    throw new GatewayAuthError('missing gateway auth headers', 401);
  }
  const timestamp = Number(timestampStr);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new GatewayAuthError('invalid timestamp', 401);
  }
  const now = (input.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (Math.abs(now - timestamp) > SKEW_SECONDS) {
    throw new GatewayAuthError('timestamp outside acceptable skew window', 401);
  }
  const secret = getSecret();
  const bodyHash = hashBody(input.body);
  const canonical = canonicalString(
    input.method,
    input.path,
    tenantId,
    timestamp,
    nonce,
    bodyHash,
  );
  const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    throw new GatewayAuthError('signature not valid base64', 401);
  }
  // timingSafeEqual requires equal lengths; mismatched length is itself
  // a failure but must not short-circuit before a constant-time check
  // on the same number of bytes either side would have read.
  if (given.length !== expected.length) {
    throw new GatewayAuthError('signature mismatch', 401);
  }
  if (!timingSafeEqual(given, expected)) {
    throw new GatewayAuthError('signature mismatch', 401);
  }
  return { tenantId, timestamp, nonce };
}

// Header name constants exported for callers that want to read or
// allow-list them outside this module.
export const GATEWAY_AUTH_HEADERS = {
  tenant: HEADER_TENANT,
  timestamp: HEADER_TIMESTAMP,
  nonce: HEADER_NONCE,
  signature: HEADER_SIGNATURE,
} as const;
