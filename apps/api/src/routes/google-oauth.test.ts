import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetAppState, setRuntimeRegistryForTests } from '../state.js';
import { readJson } from '../test-helpers.js';
import {
  setClockForTests,
  setGoogleOAuthClientForTests,
  type GoogleOAuthClient,
  type OAuthCodeExchangeResult,
} from './google-oauth.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER = '00000000-0000-0000-0000-000000000111';
const ADMIN_HEADERS = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
  'x-user-role': 'admin',
};
const MEMBER_HEADERS = {
  'x-tenant-id': TENANT,
  'x-user-id': USER,
};

class StubOAuthClient implements GoogleOAuthClient {
  buildAuthorizeUrlCalls: Array<{ state: string; scopes: string[] }> = [];
  exchangeCalls: string[] = [];
  nextExchange: OAuthCodeExchangeResult = {
    accessToken: 'ya29.stub-access',
    refreshToken: '1//0stub-refresh',
    expiryEpochMs: 0,
  };
  authorizeError: Error | null = null;
  exchangeError: Error | null = null;

  buildAuthorizeUrl(input: { state: string; scopes: string[] }): string {
    this.buildAuthorizeUrlCalls.push(input);
    if (this.authorizeError) throw this.authorizeError;
    return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(input.state)}`;
  }

  async exchangeCode(code: string): Promise<OAuthCodeExchangeResult> {
    this.exchangeCalls.push(code);
    if (this.exchangeError) throw this.exchangeError;
    return this.nextExchange;
  }
}

const T_NOW = 1_700_000_000_000;

interface TestCtx {
  dir: string;
  app: ReturnType<typeof createApp>;
  stubClient: StubOAuthClient;
  priorMaster: string | undefined;
}

async function setup(): Promise<TestCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'ventus-gauth-'));
  process.env.VENTUS_SKILLS_DIR = dir;
  process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
  process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
  process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
  process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
  process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
  process.env.VENTUS_CREDENTIAL_STORE = join(dir, 'credentials.json');
  const priorMaster = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  process.env.VENTUS_CREDENTIAL_MASTER_KEY = Buffer.from('m'.repeat(32)).toString('base64');
  process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:8080/auth/google/callback';
  process.env.VENTUS_OAUTH_STATE_SECRET = 's'.repeat(32);
  resetAppState();
  setRuntimeRegistryForTests(null);
  setClockForTests(() => T_NOW);
  const stubClient = new StubOAuthClient();
  setGoogleOAuthClientForTests(() => stubClient);
  const app = createApp();
  return { dir, app, stubClient, priorMaster };
}

async function teardown(ctx: TestCtx): Promise<void> {
  delete process.env.VENTUS_SKILLS_DIR;
  delete process.env.VENTUS_PROPOSAL_STORE;
  delete process.env.VENTUS_AUDIT_STORE;
  delete process.env.VENTUS_OUTBOX;
  delete process.env.VENTUS_RUN_STORE;
  delete process.env.VENTUS_TENANT_PROFILE_STORE;
  delete process.env.VENTUS_CREDENTIAL_STORE;
  if (ctx.priorMaster === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  else process.env.VENTUS_CREDENTIAL_MASTER_KEY = ctx.priorMaster;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.VENTUS_OAUTH_STATE_SECRET;
  resetAppState();
  setRuntimeRegistryForTests(null);
  setClockForTests(null);
  setGoogleOAuthClientForTests(null);
  await rm(ctx.dir, { recursive: true, force: true });
}

describe('GET /v1/auth/google/start', () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  it('rejects non-admin callers with 403', async () => {
    const res = await ctx.app.request('/v1/auth/google/start', { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it('returns 503 when GOOGLE_CLIENT_ID is missing', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await ctx.app.request('/v1/auth/google/start', { headers: ADMIN_HEADERS });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/GOOGLE_CLIENT_ID/);
  });

  it('returns the authorize URL and a signed state token', async () => {
    const res = await ctx.app.request('/v1/auth/google/start', { headers: ADMIN_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authUrl: string;
      state: string;
      expiresInMs: number;
    };
    expect(body.authUrl).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(body.state).toContain('.');
    expect(body.expiresInMs).toBeGreaterThan(0);
    // Stub recorded the call with the same state.
    expect(ctx.stubClient.buildAuthorizeUrlCalls).toHaveLength(1);
    expect(ctx.stubClient.buildAuthorizeUrlCalls[0]?.state).toBe(body.state);
    // Scopes must include gmail.send (the forwarder uses it).
    expect(ctx.stubClient.buildAuthorizeUrlCalls[0]?.scopes).toContain(
      'https://www.googleapis.com/auth/gmail.send',
    );
  });

  it('generates a distinct state token per call (nonce is fresh)', async () => {
    const a = await readJson<{ state: string }>(
      await ctx.app.request('/v1/auth/google/start', { headers: ADMIN_HEADERS }),
    );
    const b = await readJson<{ state: string }>(
      await ctx.app.request('/v1/auth/google/start', { headers: ADMIN_HEADERS }),
    );
    expect(a.state).not.toBe(b.state);
  });
});

describe('GET /auth/google/callback', () => {
  let ctx: TestCtx;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  async function mintState(): Promise<string> {
    const res = await ctx.app.request('/v1/auth/google/start', { headers: ADMIN_HEADERS });
    const body = (await res.json()) as { state: string };
    return body.state;
  }

  it('exchanges code, stores the credential blob, and returns connected metadata', async () => {
    ctx.stubClient.nextExchange = {
      accessToken: 'ya29.live-access',
      refreshToken: '1//0live-refresh',
      expiryEpochMs: T_NOW + 3_600_000,
    };
    const state = await mintState();

    const res = await ctx.app.request(
      `/auth/google/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; connector: string; tenantId: string };
    expect(body.ok).toBe(true);
    expect(body.connector).toBe('gmail');
    expect(body.tenantId).toBe(TENANT);
    expect(ctx.stubClient.exchangeCalls).toEqual(['AUTHCODE']);
  });

  it('writes the credential blob to the vault in the shape the GmailForwarder expects', async () => {
    ctx.stubClient.nextExchange = {
      accessToken: 'ya29.live-access',
      refreshToken: '1//0live-refresh',
      expiryEpochMs: T_NOW + 3_600_000,
    };
    const state = await mintState();
    const res = await ctx.app.request(
      `/auth/google/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(200);

    // Re-load the credential via the FileCredentialStore directly to assert
    // the on-disk shape matches the forwarder's parseGmailCredential contract.
    const { FileCredentialStore } = await import('@ventus/credentials');
    const store = new FileCredentialStore(process.env.VENTUS_CREDENTIAL_STORE as string);
    const raw = await store.get(TENANT, 'gmail');
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw as string) as {
      accessToken: string;
      refreshToken: string;
      expiryEpochMs: number;
    };
    expect(blob.accessToken).toBe('ya29.live-access');
    expect(blob.refreshToken).toBe('1//0live-refresh');
    expect(blob.expiryEpochMs).toBe(T_NOW + 3_600_000);
  });

  it('NEVER stores access_token or refresh_token in the audit log', async () => {
    const accessToken = 'ya29.canary-access-shouldnt-leak';
    const refreshToken = '1//0canary-refresh-shouldnt-leak';
    ctx.stubClient.nextExchange = {
      accessToken,
      refreshToken,
      expiryEpochMs: T_NOW + 3_600_000,
    };
    const state = await mintState();
    await ctx.app.request(
      `/auth/google/callback?code=AUTHCODE&state=${encodeURIComponent(state)}`,
    );

    const auditBody = await readJson(
      await ctx.app.request('/v1/audit', { headers: ADMIN_HEADERS }),
    );
    const auditRaw = JSON.stringify(auditBody);
    expect(auditRaw).not.toContain(accessToken);
    expect(auditRaw).not.toContain(refreshToken);
    // The connect action itself should still be visible.
    expect(auditRaw).toContain('connect_gmail');
  });

  it('rejects callbacks with no state', async () => {
    const res = await ctx.app.request('/auth/google/callback?code=X');
    expect(res.status).toBe(400);
  });

  it('rejects callbacks with no code', async () => {
    const state = await mintState();
    const res = await ctx.app.request(
      `/auth/google/callback?state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(400);
  });

  it('rejects forged states (wrong secret signature)', async () => {
    // Forge a state with the wrong secret — the verifier should refuse.
    const { createHmac } = await import('node:crypto');
    const body = Buffer.from(
      JSON.stringify({ t: TENANT, u: USER, n: 'n', e: T_NOW + 60_000 }),
    ).toString('base64url');
    const sig = createHmac('sha256', 'wrong-secret').update(body).digest('base64url');
    const forged = `${body}.${sig}`;
    const res = await ctx.app.request(
      `/auth/google/callback?code=X&state=${encodeURIComponent(forged)}`,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/signature/);
  });

  it('rejects expired state tokens', async () => {
    const state = await mintState();
    // Jump 11 minutes past the state expiry.
    setClockForTests(() => T_NOW + 11 * 60_000);
    const res = await ctx.app.request(
      `/auth/google/callback?code=X&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/expired/);
  });

  it('returns 400 when google redirected with ?error=...', async () => {
    const res = await ctx.app.request(
      '/auth/google/callback?error=access_denied&state=anything',
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe('access_denied');
  });

  it('returns 502 when code exchange throws', async () => {
    ctx.stubClient.exchangeError = new Error('invalid_grant');
    const state = await mintState();
    const res = await ctx.app.request(
      `/auth/google/callback?code=X&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(502);
  });

  it('uses tenantId FROM the signed state, not from any header', async () => {
    // Mint state for TENANT. Then send the callback with a DIFFERENT
    // x-tenant-id header. The credential MUST be written under the state's
    // tenant, not the header's — otherwise a caller who knows a state for
    // tenant A could redirect themselves and capture credentials under
    // tenant B.
    ctx.stubClient.nextExchange = {
      accessToken: 'ya29.live',
      refreshToken: '1//0live',
      expiryEpochMs: T_NOW + 3_600_000,
    };
    const state = await mintState();
    const OTHER_TENANT = '00000000-0000-0000-0000-00000000000b';
    const res = await ctx.app.request(
      `/auth/google/callback?code=X&state=${encodeURIComponent(state)}`,
      { headers: { 'x-tenant-id': OTHER_TENANT, 'x-user-id': USER } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenantId: string };
    expect(body.tenantId).toBe(TENANT);

    const { FileCredentialStore } = await import('@ventus/credentials');
    const store = new FileCredentialStore(process.env.VENTUS_CREDENTIAL_STORE as string);
    const credForTenantA = await store.get(TENANT, 'gmail');
    const credForOther = await store.get(OTHER_TENANT, 'gmail');
    expect(credForTenantA).not.toBeNull();
    expect(credForOther).toBeNull();
  });
});
