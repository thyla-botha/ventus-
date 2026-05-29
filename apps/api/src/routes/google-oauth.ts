import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { hashPayload } from '@ventus/audit';
import { requireAdmin } from '../middleware/tenant.js';
import { getAppState } from '../state.js';

// Gmail OAuth onboarding flow.
//
// Two endpoints, mounted at two different roots:
//
//   GET  /v1/auth/google/start    — admin-gated; signs a state token and
//                                   returns Google's authorize URL.
//   GET  /auth/google/callback    — mounted OUTSIDE /v1 so it doesn't need
//                                   the tenant middleware. Google redirects
//                                   the user's browser here with ?code=...
//                                   &state=...; we verify the signed state
//                                   to identify the tenant, exchange the
//                                   code for a token pair, and persist the
//                                   {accessToken, refreshToken, expiryEpochMs}
//                                   JSON blob into the credential vault under
//                                   (tenantId, 'gmail'). The shape matches what
//                                   the GmailForwarder (PR 4) parses on every
//                                   tool-call.
//
// What the state token does:
//   - Identifies which tenant + user kicked off the flow (the callback has
//     no authenticated context, so we can't rely on JWT/header trust).
//   - Has a TTL so a leaked URL can't be replayed weeks later.
//   - Is HMAC-signed with VENTUS_OAUTH_STATE_SECRET so a caller can't
//     forge state for someone else's tenantId.
//
// What we audit:
//   - The fact that a connection was completed, including the user who did
//     it and a SHA-256 hash of the refresh token (so "is this the same
//     refresh token as before?" is answerable without storing the value).
//   - NEVER the raw access_token or refresh_token. Those land only in the
//     encrypted vault row.

export const googleOAuthStart = new Hono();
export const googleOAuthCallback = new Hono();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
];

// 10 minutes is enough for the user to click through Google's consent
// screen but short enough that a leaked URL doesn't stay weaponizable.
const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  t: string; // tenantId
  u: string; // userId
  n: string; // nonce
  e: number; // expiresAt epoch ms
}

function signState(payload: StatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(token: string, secret: string, nowMs: number): StatePayload {
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) {
    throw new Error('state token malformed');
  }
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('state token signature mismatch');
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    throw new Error('state token payload not JSON');
  }
  if (
    typeof payload.t !== 'string' ||
    typeof payload.u !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.e !== 'number'
  ) {
    throw new Error('state token payload missing fields');
  }
  if (payload.e < nowMs) {
    throw new Error('state token expired');
  }
  return payload;
}

interface OAuthEnv {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
}

function readOAuthEnv(): OAuthEnv | { error: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const stateSecret = process.env.VENTUS_OAUTH_STATE_SECRET;
  if (!clientId) return { error: 'GOOGLE_CLIENT_ID not set' };
  if (!clientSecret) return { error: 'GOOGLE_CLIENT_SECRET not set' };
  if (!redirectUri) return { error: 'GOOGLE_REDIRECT_URI not set' };
  if (!stateSecret) return { error: 'VENTUS_OAUTH_STATE_SECRET not set' };
  return { clientId, clientSecret, redirectUri, stateSecret };
}

// Minimal surface we need from Google's OAuth2 client. Behind an interface
// so tests can swap in a stub instead of network-hitting Google during
// every test run. The real impl uses googleapis (loaded lazily via
// dynamic import so unit tests that don't touch it skip the cost).
export interface OAuthCodeExchangeResult {
  accessToken: string;
  refreshToken: string;
  expiryEpochMs: number;
}

export interface GoogleOAuthClient {
  buildAuthorizeUrl(input: { state: string; scopes: string[] }): string;
  exchangeCode(code: string): Promise<OAuthCodeExchangeResult>;
}

// Default real client. Each request constructs a fresh OAuth2Client because
// the SDK mutates internal state on token exchange — sharing one across
// concurrent callbacks would mix tokens between tenants.
class GoogleApiOAuthClient implements GoogleOAuthClient {
  constructor(private readonly env: OAuthEnv) {}

  buildAuthorizeUrl(input: { state: string; scopes: string[] }): string {
    // We do NOT want to lazy-load on every request, but for the FIRST
    // call we can afford the ~50ms SDK import. Subsequent calls reuse the
    // cached module.
    return buildAuthorizeUrlSync({
      clientId: this.env.clientId,
      redirectUri: this.env.redirectUri,
      scopes: input.scopes,
      state: input.state,
    });
  }

  async exchangeCode(code: string): Promise<OAuthCodeExchangeResult> {
    const { google } = await loadGoogleApis();
    const client = new google.auth.OAuth2(
      this.env.clientId,
      this.env.clientSecret,
      this.env.redirectUri,
    );
    const res = await client.getToken(code);
    const tokens = res.tokens ?? {};
    if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
      throw new Error('google returned no access_token');
    }
    if (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length === 0) {
      // No refresh_token means the user previously consented and Google
      // chose not to re-issue one. Forcing prompt: 'consent' on /start
      // makes Google return it again. If we still don't have one, the
      // forwarder can't refresh later — fail loud now, not at first
      // forward call.
      throw new Error('google returned no refresh_token (re-consent required)');
    }
    const expiryEpochMs =
      typeof tokens.expiry_date === 'number' && Number.isFinite(tokens.expiry_date)
        ? tokens.expiry_date
        : Date.now() + 3_600_000;
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryEpochMs,
    };
  }
}

// The authorize URL only needs query-string assembly — no network call —
// so we build it ourselves instead of paying the import cost on /start.
function buildAuthorizeUrlSync(input: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    access_type: 'offline',
    // Forcing the consent screen on every /start guarantees Google
    // re-issues a refresh_token. Without this, re-connects silently
    // return access_token only and the forwarder can't refresh.
    prompt: 'consent',
    state: input.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type GoogleApisModule = typeof import('googleapis');
let googleApisCache: Promise<GoogleApisModule> | null = null;
function loadGoogleApis(): Promise<GoogleApisModule> {
  if (!googleApisCache) {
    googleApisCache = import('googleapis');
  }
  return googleApisCache;
}

// Test seam: swap the real OAuth client for a stub during unit tests so
// we don't hit Google's token endpoint or the random nonce path.
let clientFactoryOverride:
  | ((env: OAuthEnv) => GoogleOAuthClient)
  | null = null;
export function setGoogleOAuthClientForTests(
  factory: ((env: OAuthEnv) => GoogleOAuthClient) | null,
): void {
  clientFactoryOverride = factory;
}

function resolveClient(env: OAuthEnv): GoogleOAuthClient {
  if (clientFactoryOverride) return clientFactoryOverride(env);
  return new GoogleApiOAuthClient(env);
}

// Test seam: pin the clock so state-expiry tests are deterministic.
let clockOverride: (() => number) | null = null;
export function setClockForTests(fn: (() => number) | null): void {
  clockOverride = fn;
}
function nowMs(): number {
  return clockOverride ? clockOverride() : Date.now();
}

// ---------------------------------------------------------------------------
// GET /v1/auth/google/start
// ---------------------------------------------------------------------------
googleOAuthStart.get('/start', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;

  const env = readOAuthEnv();
  if ('error' in env) {
    return c.json({ error: `google oauth not configured: ${env.error}` }, 503);
  }

  const nonce = randomBytes(16).toString('hex');
  const state = signState(
    {
      t: c.var.tenantId,
      u: c.var.userId,
      n: nonce,
      e: nowMs() + STATE_TTL_MS,
    },
    env.stateSecret,
  );

  const client = resolveClient(env);
  const authUrl = client.buildAuthorizeUrl({ state, scopes: SCOPES });

  return c.json({ authUrl, state, expiresInMs: STATE_TTL_MS });
});

// ---------------------------------------------------------------------------
// GET /auth/google/callback
// ---------------------------------------------------------------------------
googleOAuthCallback.get('/callback', async (c) => {
  const env = readOAuthEnv();
  if ('error' in env) {
    return c.json({ error: `google oauth not configured: ${env.error}` }, 503);
  }

  // Google may redirect with ?error=... if the user denies consent. Surface
  // that as 400 with the upstream code so the UI can render a meaningful
  // message ("you cancelled the connection").
  const errParam = c.req.query('error');
  if (errParam) {
    return c.json({ error: 'google denied authorization', code: errParam }, 400);
  }

  const code = c.req.query('code');
  const stateToken = c.req.query('state');
  if (!code || !stateToken) {
    return c.json({ error: 'missing code or state' }, 400);
  }

  let parsedState: StatePayload;
  try {
    parsedState = verifyState(stateToken, env.stateSecret, nowMs());
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return c.json({ error: `invalid state: ${text}` }, 400);
  }

  const client = resolveClient(env);
  let tokens: OAuthCodeExchangeResult;
  try {
    tokens = await client.exchangeCode(code);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error('[google-oauth] code exchange failed:', text);
    return c.json({ error: 'code exchange failed' }, 502);
  }

  const blob = JSON.stringify({
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryEpochMs: tokens.expiryEpochMs,
  });

  const { credentials, audit } = getAppState();
  const startedAt = Date.now();

  // Audit the connection event. Payload hashes the refresh token so the
  // operator can answer "did the user re-connect with the same Google
  // account?" without storing the value. The plaintext lives only in the
  // vault.
  const intentPayload = {
    tenantId: parsedState.t,
    actorUserId: parsedState.u,
    scopes: SCOPES,
    refreshTokenHash: hashPayload(tokens.refreshToken),
  };
  const intent = await audit.recordIntent({
    tenantId: parsedState.t,
    stepNo: 0,
    actorType: 'user',
    actorId: parsedState.u,
    action: 'connect_gmail',
    resourceType: 'connector_credential',
    resourceId: 'gmail',
    payload: intentPayload,
    payloadHash: hashPayload(intentPayload),
  });

  try {
    const meta = await credentials.set(parsedState.t, 'gmail', blob, {
      updatedBy: parsedState.u,
    });
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId: parsedState.t,
        status: 'executed',
        result: { connector: 'gmail', updatedAt: meta.updatedAt },
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    return c.json({
      ok: true,
      connector: 'gmail',
      tenantId: parsedState.t,
      connectedAt: meta.updatedAt,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId: parsedState.t,
        status: 'failed',
        errorText: text,
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.error('[google-oauth] credential persist failed:', text);
    return c.json({ error: 'could not store connection' }, 500);
  }
});
