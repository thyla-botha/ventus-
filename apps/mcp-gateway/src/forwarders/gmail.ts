import type { ConnectorType, CredentialStore } from '@ventus/credentials';
import type { ForwardInput, ForwardResult, ToolForwarder } from '../forwarder.js';

// GmailForwarder dispatches Gmail tool-calls (send, draft) over the real
// Google Gmail API. It owns the per-tenant OAuth lifecycle:
//
//   1. The vault credential is a JSON blob, not a bare token, so we can
//      carry both halves of the OAuth pair plus an expiry. Bare access
//      tokens with no refresh hook would mean every tool call after the
//      1h expiry returns 401.
//   2. Before every send/draft we check expiry against now+REFRESH_BUFFER.
//      If we're inside the buffer we refresh via the injected OAuthRefresher
//      (real impl: google-auth-library OAuth2Client.refreshAccessToken;
//      mock impl: any stub returning the same shape).
//   3. After a successful refresh we re-encrypt the new blob back into the
//      credential store under the SAME (tenantId, 'gmail') row. The
//      encryption is per-tenant — see packages/credentials/src/crypto.ts.
//   4. The GmailClient abstraction is what actually talks to Google. The
//      real impl is GoogleApiGmailClient (googleapis SDK); tests inject a
//      stub. This lets us assert RFC 2822 framing, draft creation, and
//      error surfaces without faking HTTP one layer lower.
//
// What the forwarder DOES NOT do:
//   - It never logs the access or refresh token. Errors caught here are
//     rethrown plain so the gateway's outer catch can scrub + audit.
//   - It does not stash credentials in process memory beyond the
//     forward() invocation. Each call re-decrypts from the vault.

// 60s buffer before the actual expiry so an in-flight call doesn't hit a
// just-expired token. Google's OAuth tokens live 3600s; refreshing one
// minute early is essentially free and saves the round-trip-retry path.
const REFRESH_BUFFER_MS = 60_000;

// Shape of the JSON blob we persist into the credential vault for a Gmail
// connection. The vault row is the JSON.stringify of this object.
export interface GmailCredentialBlob {
  accessToken: string;
  refreshToken: string;
  // Absolute epoch ms when the access token expires. We persist the
  // absolute time, not a TTL, so the buffer check is a single subtraction
  // regardless of how long the blob has been sitting in the vault.
  expiryEpochMs: number;
}

export function parseGmailCredential(raw: string): GmailCredentialBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('gmail credential blob is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('gmail credential blob must be an object');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.accessToken !== 'string' || o.accessToken.length === 0) {
    throw new Error('gmail credential blob: accessToken missing');
  }
  if (typeof o.refreshToken !== 'string' || o.refreshToken.length === 0) {
    throw new Error('gmail credential blob: refreshToken missing');
  }
  if (typeof o.expiryEpochMs !== 'number' || !Number.isFinite(o.expiryEpochMs)) {
    throw new Error('gmail credential blob: expiryEpochMs missing or not a number');
  }
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken,
    expiryEpochMs: o.expiryEpochMs,
  };
}

export function serializeGmailCredential(blob: GmailCredentialBlob): string {
  return JSON.stringify(blob);
}

// Minimal Gmail client surface — only what we forward. Keeping this
// narrow means the stub for tests is small and the real impl can swap
// SDKs (googleapis vs gaxios direct) without touching the forwarder.
export interface SendMessageInput {
  // RFC 2822 message text. The forwarder builds this from {to,subject,body}
  // before handing it down so the client itself is dumb.
  rfc2822: string;
  accessToken: string;
}

export interface CreateDraftInput {
  rfc2822: string;
  accessToken: string;
}

export interface SentMessageResult {
  id: string;
  threadId?: string;
}

export interface CreatedDraftResult {
  id: string;
  messageId?: string;
}

export interface GmailClient {
  send(input: SendMessageInput): Promise<SentMessageResult>;
  createDraft(input: CreateDraftInput): Promise<CreatedDraftResult>;
}

// OAuthRefresher abstracts the "swap refresh_token for a new access_token"
// step. The real impl uses google-auth-library; tests inject a counter so
// they can assert refresh was (or was not) called.
export interface RefreshedToken {
  accessToken: string;
  // Some providers rotate the refresh_token on use. Optional because
  // Google usually returns null here — keep the previous one in that case.
  refreshToken?: string | null;
  expiryEpochMs: number;
}

export interface OAuthRefresher {
  refresh(currentRefreshToken: string): Promise<RefreshedToken>;
}

// Minimal clock surface, injectable so tests can pin time deterministically.
export interface Clock {
  nowMs(): number;
}

const realClock: Clock = { nowMs: () => Date.now() };

// Input schema for the two tools we expose. We accept these from the
// agent runtime; PII scrubbing has already run by the time forward() sees
// them, so the body may still have business content but no PII patterns.
export interface GmailSendArgs {
  to: string;
  subject: string;
  body: string;
  // Optional sender. If absent the gateway uses 'me' which means
  // "the authenticated user" per the Gmail API.
  from?: string;
}

export interface GmailDraftArgs {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

function isStringField(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parseSendArgs(raw: unknown): GmailSendArgs {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gmail.send: input must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (!isStringField(o.to)) throw new Error('gmail.send: "to" must be a non-empty string');
  if (!isStringField(o.subject)) throw new Error('gmail.send: "subject" must be a non-empty string');
  if (typeof o.body !== 'string') throw new Error('gmail.send: "body" must be a string');
  return {
    to: o.to,
    subject: o.subject,
    body: o.body,
    ...(isStringField(o.from) ? { from: o.from } : {}),
  };
}

function parseDraftArgs(raw: unknown): GmailDraftArgs {
  if (!raw || typeof raw !== 'object') {
    throw new Error('gmail.draft: input must be an object');
  }
  const o = raw as Record<string, unknown>;
  if (!isStringField(o.to)) throw new Error('gmail.draft: "to" must be a non-empty string');
  if (!isStringField(o.subject)) throw new Error('gmail.draft: "subject" must be a non-empty string');
  if (typeof o.body !== 'string') throw new Error('gmail.draft: "body" must be a string');
  return {
    to: o.to,
    subject: o.subject,
    body: o.body,
    ...(isStringField(o.from) ? { from: o.from } : {}),
  };
}

// Build an RFC 2822 message body. Gmail's users.messages.send accepts a
// base64url-encoded RFC 2822 string. We assemble it here so the client
// just has to do the encoding step. Subject is encoded as quoted-printable
// to survive non-ASCII characters safely.
export function buildRfc2822(args: { to: string; subject: string; body: string; from?: string }): string {
  const headers: string[] = [
    `To: ${args.to}`,
    `Subject: ${encodeSubjectIfNeeded(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (args.from) headers.unshift(`From: ${args.from}`);
  return `${headers.join('\r\n')}\r\n\r\n${args.body}`;
}

function encodeSubjectIfNeeded(s: string): string {
  // RFC 2047 encoded-word if the subject has any non-ASCII bytes. Keeps
  // ASCII-only subjects readable in the wire format.
  // eslint-disable-next-line no-control-regex
  if (!/[\x80-￿]/.test(s)) return s;
  const b64 = Buffer.from(s, 'utf-8').toString('base64');
  return `=?UTF-8?B?${b64}?=`;
}

export interface GmailForwarderOptions {
  credentials: CredentialStore;
  client: GmailClient;
  refresher: OAuthRefresher;
  clock?: Clock;
}

export class GmailForwarder implements ToolForwarder {
  readonly connectorType: ConnectorType = 'gmail';
  private readonly clock: Clock;

  constructor(private readonly opts: GmailForwarderOptions) {
    this.clock = opts.clock ?? realClock;
  }

  async forward(input: ForwardInput): Promise<ForwardResult> {
    if (input.connector !== 'gmail') {
      throw new Error(`gmail forwarder received non-gmail connector: ${input.connector}`);
    }

    // Decrypt + parse the OAuth blob. The gateway has already pulled the
    // raw decrypted string from the vault; we just have to interpret it.
    const blob = parseGmailCredential(input.credential);
    const fresh = await this.ensureFreshToken(input.tenantId, blob);

    switch (input.tool) {
      case 'send': {
        const args = parseSendArgs(input.input);
        const rfc2822 = buildRfc2822(args);
        const sent = await this.opts.client.send({ rfc2822, accessToken: fresh.accessToken });
        return {
          ok: true,
          data: { id: sent.id, ...(sent.threadId ? { threadId: sent.threadId } : {}) },
        };
      }
      case 'draft': {
        const args = parseDraftArgs(input.input);
        const rfc2822 = buildRfc2822(args);
        const draft = await this.opts.client.createDraft({ rfc2822, accessToken: fresh.accessToken });
        return {
          ok: true,
          data: {
            id: draft.id,
            ...(draft.messageId ? { messageId: draft.messageId } : {}),
          },
        };
      }
      default:
        throw new Error(`gmail forwarder: unsupported tool "${input.tool}"`);
    }
  }

  // Returns a blob whose accessToken is good for at least REFRESH_BUFFER_MS.
  // If the stored blob is still fresh, returns it unchanged. If it's not,
  // performs an OAuth refresh and writes the new blob back to the vault
  // under the same row, then returns the new blob.
  private async ensureFreshToken(
    tenantId: string,
    blob: GmailCredentialBlob,
  ): Promise<GmailCredentialBlob> {
    const now = this.clock.nowMs();
    if (blob.expiryEpochMs > now + REFRESH_BUFFER_MS) {
      return blob;
    }
    const refreshed = await this.opts.refresher.refresh(blob.refreshToken);
    const next: GmailCredentialBlob = {
      accessToken: refreshed.accessToken,
      // Google sometimes returns a new refresh_token, sometimes null. Keep
      // whichever we have, preferring the new one.
      refreshToken: refreshed.refreshToken ?? blob.refreshToken,
      expiryEpochMs: refreshed.expiryEpochMs,
    };
    await this.opts.credentials.set(tenantId, 'gmail', serializeGmailCredential(next), {
      updatedBy: 'gmail-oauth-refresh',
    });
    return next;
  }
}

// Real Gmail client implementation, deferred behind a lazy dynamic import
// so unit tests can build a forwarder without pulling googleapis into the
// test graph. The wrapper translates our minimal shape into the SDK call.
export class GoogleApiGmailClient implements GmailClient {
  async send(input: SendMessageInput): Promise<SentMessageResult> {
    const { gmail, OAuth2 } = await loadGoogleSdks();
    const auth = new OAuth2();
    auth.setCredentials({ access_token: input.accessToken });
    const svc = gmail({ version: 'v1', auth });
    const res = await svc.users.messages.send({
      userId: 'me',
      requestBody: { raw: toBase64Url(input.rfc2822) },
    });
    const data = res.data ?? {};
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) throw new Error('gmail.send: API returned no message id');
    return {
      id,
      ...(typeof data.threadId === 'string' ? { threadId: data.threadId } : {}),
    };
  }

  async createDraft(input: CreateDraftInput): Promise<CreatedDraftResult> {
    const { gmail, OAuth2 } = await loadGoogleSdks();
    const auth = new OAuth2();
    auth.setCredentials({ access_token: input.accessToken });
    const svc = gmail({ version: 'v1', auth });
    const res = await svc.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: toBase64Url(input.rfc2822) } },
    });
    const data = res.data ?? {};
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) throw new Error('gmail.draft: API returned no draft id');
    const messageId =
      data.message && typeof data.message === 'object' && typeof (data.message as { id?: unknown }).id === 'string'
        ? (data.message as { id: string }).id
        : undefined;
    return { id, ...(messageId ? { messageId } : {}) };
  }
}

// Real OAuth refresher backed by google-auth-library's OAuth2Client. Reads
// GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from env so PR 5 can wire the
// onboarding flow without touching the forwarder.
export class GoogleOAuthRefresher implements OAuthRefresher {
  async refresh(currentRefreshToken: string): Promise<RefreshedToken> {
    const { OAuth2 } = await loadGoogleSdks();
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        'gmail oauth refresh: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set',
      );
    }
    const client = new OAuth2(clientId, clientSecret);
    client.setCredentials({ refresh_token: currentRefreshToken });
    const res = await client.refreshAccessToken();
    const creds = res.credentials ?? {};
    if (typeof creds.access_token !== 'string' || creds.access_token.length === 0) {
      throw new Error('gmail oauth refresh: provider returned no access_token');
    }
    // expiry_date is absolute epoch ms per google-auth-library docs. Fall
    // back to now + 1h if it's missing — Google's default token lifetime.
    const expiryEpochMs =
      typeof creds.expiry_date === 'number' && Number.isFinite(creds.expiry_date)
        ? creds.expiry_date
        : Date.now() + 3_600_000;
    return {
      accessToken: creds.access_token,
      refreshToken:
        typeof creds.refresh_token === 'string' && creds.refresh_token.length > 0
          ? creds.refresh_token
          : null,
      expiryEpochMs,
    };
  }
}

function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

type GoogleSdks = {
  gmail: (typeof import('googleapis'))['google']['gmail'];
  OAuth2: (typeof import('googleapis'))['google']['auth']['OAuth2'];
};

let sdkCache: Promise<GoogleSdks> | null = null;
function loadGoogleSdks(): Promise<GoogleSdks> {
  if (!sdkCache) {
    sdkCache = import('googleapis').then(({ google }) => ({
      gmail: google.gmail,
      OAuth2: google.auth.OAuth2,
    }));
  }
  return sdkCache;
}
