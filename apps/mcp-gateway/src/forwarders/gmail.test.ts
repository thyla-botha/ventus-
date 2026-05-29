import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from '@ventus/credentials';
import {
  GmailForwarder,
  buildRfc2822,
  parseGmailCredential,
  serializeGmailCredential,
  type Clock,
  type CreatedDraftResult,
  type CreateDraftInput,
  type GmailClient,
  type GmailCredentialBlob,
  type OAuthRefresher,
  type RefreshedToken,
  type SendMessageInput,
  type SentMessageResult,
} from './gmail.js';

// 32 random bytes, base64-encoded. The credential crypto layer requires
// exactly 32 decoded bytes — see packages/credentials/src/crypto.ts.
const TEST_MASTER_KEY = '8H5Wd8EyMmnJB2zvWdqh2HAhhVryFpidnLHnvJEfWw4=';

async function withMasterKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  process.env.VENTUS_CREDENTIAL_MASTER_KEY = TEST_MASTER_KEY;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
    else process.env.VENTUS_CREDENTIAL_MASTER_KEY = prev;
  }
}

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-forwarder-'));
  return join(dir, 'creds.json');
}

class StubGmailClient implements GmailClient {
  sendCalls: SendMessageInput[] = [];
  draftCalls: CreateDraftInput[] = [];
  nextSend: SentMessageResult = { id: 'msg-1', threadId: 'thr-1' };
  nextDraft: CreatedDraftResult = { id: 'draft-1', messageId: 'msg-1' };
  sendError: Error | null = null;
  draftError: Error | null = null;

  async send(input: SendMessageInput): Promise<SentMessageResult> {
    this.sendCalls.push(input);
    if (this.sendError) throw this.sendError;
    return this.nextSend;
  }

  async createDraft(input: CreateDraftInput): Promise<CreatedDraftResult> {
    this.draftCalls.push(input);
    if (this.draftError) throw this.draftError;
    return this.nextDraft;
  }
}

class StubRefresher implements OAuthRefresher {
  calls: string[] = [];
  nextToken: RefreshedToken = {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiryEpochMs: 0,
  };
  shouldThrow: Error | null = null;

  async refresh(currentRefreshToken: string): Promise<RefreshedToken> {
    this.calls.push(currentRefreshToken);
    if (this.shouldThrow) throw this.shouldThrow;
    return this.nextToken;
  }
}

function fixedClock(nowMs: number): Clock {
  return { nowMs: () => nowMs };
}

const T_NOW = 1_700_000_000_000;

function freshBlob(over: Partial<GmailCredentialBlob> = {}): GmailCredentialBlob {
  return {
    accessToken: 'access-current',
    refreshToken: 'refresh-current',
    // 10 minutes in the future — well clear of the 60s refresh buffer.
    expiryEpochMs: T_NOW + 10 * 60_000,
    ...over,
  };
}

describe('parseGmailCredential', () => {
  it('parses a well-formed JSON blob', () => {
    const blob = freshBlob();
    const parsed = parseGmailCredential(serializeGmailCredential(blob));
    expect(parsed).toEqual(blob);
  });

  it('rejects non-JSON input', () => {
    expect(() => parseGmailCredential('not json')).toThrow(/not valid JSON/);
  });

  it('rejects blobs missing accessToken', () => {
    const blob: Partial<GmailCredentialBlob> = {
      refreshToken: 'r',
      expiryEpochMs: 1,
    };
    expect(() => parseGmailCredential(JSON.stringify(blob))).toThrow(/accessToken/);
  });

  it('rejects blobs missing refreshToken', () => {
    const blob: Partial<GmailCredentialBlob> = {
      accessToken: 'a',
      expiryEpochMs: 1,
    };
    expect(() => parseGmailCredential(JSON.stringify(blob))).toThrow(/refreshToken/);
  });

  it('rejects blobs with non-numeric expiry', () => {
    expect(() =>
      parseGmailCredential(
        JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiryEpochMs: 'soon' }),
      ),
    ).toThrow(/expiryEpochMs/);
  });
});

describe('buildRfc2822', () => {
  it('produces a minimal RFC 2822 envelope with the required headers', () => {
    const msg = buildRfc2822({
      to: 'alice@example.com',
      subject: 'Hi',
      body: 'hello there',
    });
    expect(msg).toContain('To: alice@example.com');
    expect(msg).toContain('Subject: Hi');
    expect(msg).toContain('MIME-Version: 1.0');
    expect(msg.endsWith('\r\n\r\nhello there')).toBe(true);
  });

  it('includes a From header when provided', () => {
    const msg = buildRfc2822({
      to: 'a@b.com',
      from: 'me@example.com',
      subject: 's',
      body: 'b',
    });
    expect(msg).toMatch(/^From: me@example.com/);
  });

  it('RFC 2047-encodes non-ASCII subjects', () => {
    const msg = buildRfc2822({ to: 'a@b.com', subject: 'café ☕', body: 'b' });
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  });
});

describe('GmailForwarder.forward — send', () => {
  it('sends an email with the current access token when the vault token is fresh', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const client = new StubGmailClient();
      const refresher = new StubRefresher();

      const forwarder = new GmailForwarder({
        credentials,
        client,
        refresher,
        clock: fixedClock(T_NOW),
      });
      const blob = freshBlob();

      const result = await forwarder.forward({
        tenantId: 't1',
        connector: 'gmail',
        tool: 'send',
        input: { to: 'a@b.com', subject: 'Hi', body: 'hello' },
        credential: serializeGmailCredential(blob),
      });

      expect(result).toEqual({ ok: true, data: { id: 'msg-1', threadId: 'thr-1' } });
      expect(client.sendCalls).toHaveLength(1);
      expect(client.sendCalls[0]?.accessToken).toBe('access-current');
      expect(client.sendCalls[0]?.rfc2822).toContain('To: a@b.com');
      // No refresh expected for a fresh token.
      expect(refresher.calls).toHaveLength(0);

      rmSync(path, { force: true });
    });
  });

  it('refreshes a near-expired token and writes the new blob back to the vault', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const client = new StubGmailClient();
      const refresher = new StubRefresher();
      refresher.nextToken = {
        accessToken: 'refreshed-access',
        refreshToken: 'refreshed-refresh',
        expiryEpochMs: T_NOW + 3_600_000,
      };

      const forwarder = new GmailForwarder({
        credentials,
        client,
        refresher,
        clock: fixedClock(T_NOW),
      });
      // 30s remaining — inside the 60s buffer, so we MUST refresh.
      const blob = freshBlob({ expiryEpochMs: T_NOW + 30_000 });

      await forwarder.forward({
        tenantId: 't1',
        connector: 'gmail',
        tool: 'send',
        input: { to: 'a@b.com', subject: 'Hi', body: 'hello' },
        credential: serializeGmailCredential(blob),
      });

      expect(refresher.calls).toEqual(['refresh-current']);
      // Send must have used the refreshed token, not the stale one.
      expect(client.sendCalls[0]?.accessToken).toBe('refreshed-access');

      // The vault row was overwritten with the refreshed blob.
      const stored = await credentials.get('t1', 'gmail');
      expect(stored).not.toBeNull();
      const parsed = parseGmailCredential(stored as string);
      expect(parsed.accessToken).toBe('refreshed-access');
      expect(parsed.refreshToken).toBe('refreshed-refresh');
      expect(parsed.expiryEpochMs).toBe(T_NOW + 3_600_000);

      rmSync(path, { force: true });
    });
  });

  it('keeps the previous refresh token when the provider rotates to null', async () => {
    // Google's behaviour: refresh_access_token sometimes returns
    // refresh_token: null and we must keep the one we already have.
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const client = new StubGmailClient();
      const refresher = new StubRefresher();
      refresher.nextToken = {
        accessToken: 'refreshed-access',
        refreshToken: null,
        expiryEpochMs: T_NOW + 3_600_000,
      };

      const forwarder = new GmailForwarder({
        credentials,
        client,
        refresher,
        clock: fixedClock(T_NOW),
      });
      const blob = freshBlob({ expiryEpochMs: T_NOW - 1_000 });

      await forwarder.forward({
        tenantId: 't1',
        connector: 'gmail',
        tool: 'send',
        input: { to: 'a@b.com', subject: 'Hi', body: 'hello' },
        credential: serializeGmailCredential(blob),
      });

      const stored = await credentials.get('t1', 'gmail');
      const parsed = parseGmailCredential(stored as string);
      expect(parsed.refreshToken).toBe('refresh-current');
      expect(parsed.accessToken).toBe('refreshed-access');

      rmSync(path, { force: true });
    });
  });

  it('throws on unsupported tool names', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const forwarder = new GmailForwarder({
        credentials,
        client: new StubGmailClient(),
        refresher: new StubRefresher(),
        clock: fixedClock(T_NOW),
      });
      await expect(
        forwarder.forward({
          tenantId: 't1',
          connector: 'gmail',
          tool: 'archive',
          input: {},
          credential: serializeGmailCredential(freshBlob()),
        }),
      ).rejects.toThrow(/unsupported tool/);
      rmSync(path, { force: true });
    });
  });

  it('throws when the input shape is wrong', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const forwarder = new GmailForwarder({
        credentials,
        client: new StubGmailClient(),
        refresher: new StubRefresher(),
        clock: fixedClock(T_NOW),
      });
      await expect(
        forwarder.forward({
          tenantId: 't1',
          connector: 'gmail',
          tool: 'send',
          input: { subject: 'no-to' },
          credential: serializeGmailCredential(freshBlob()),
        }),
      ).rejects.toThrow(/"to" must be/);
      rmSync(path, { force: true });
    });
  });

  it('refuses non-gmail connectors at the boundary', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const forwarder = new GmailForwarder({
        credentials,
        client: new StubGmailClient(),
        refresher: new StubRefresher(),
        clock: fixedClock(T_NOW),
      });
      await expect(
        forwarder.forward({
          tenantId: 't1',
          connector: 'slack',
          tool: 'send',
          input: { to: 'a@b.com', subject: 's', body: 'b' },
          credential: serializeGmailCredential(freshBlob()),
        }),
      ).rejects.toThrow(/non-gmail/);
      rmSync(path, { force: true });
    });
  });
});

describe('GmailForwarder.forward — draft', () => {
  it('creates a draft using the current access token', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const client = new StubGmailClient();
      const refresher = new StubRefresher();

      const forwarder = new GmailForwarder({
        credentials,
        client,
        refresher,
        clock: fixedClock(T_NOW),
      });

      const result = await forwarder.forward({
        tenantId: 't1',
        connector: 'gmail',
        tool: 'draft',
        input: { to: 'a@b.com', subject: 'Hi', body: 'hello', from: 'me@x.com' },
        credential: serializeGmailCredential(freshBlob()),
      });

      expect(result).toEqual({
        ok: true,
        data: { id: 'draft-1', messageId: 'msg-1' },
      });
      expect(client.draftCalls).toHaveLength(1);
      expect(client.draftCalls[0]?.rfc2822).toContain('From: me@x.com');
    });
  });
});

describe('GmailForwarder.forward — error surfaces', () => {
  it('propagates Gmail client errors as-is (gateway scrubs at the outer catch)', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const client = new StubGmailClient();
      client.sendError = new Error('quota exceeded');
      const forwarder = new GmailForwarder({
        credentials,
        client,
        refresher: new StubRefresher(),
        clock: fixedClock(T_NOW),
      });

      await expect(
        forwarder.forward({
          tenantId: 't1',
          connector: 'gmail',
          tool: 'send',
          input: { to: 'a@b.com', subject: 's', body: 'b' },
          credential: serializeGmailCredential(freshBlob()),
        }),
      ).rejects.toThrow('quota exceeded');
    });
  });

  it('surfaces OAuth refresh failures', async () => {
    await withMasterKey(async () => {
      const path = tempStorePath();
      const credentials = new FileCredentialStore(path);
      const refresher = new StubRefresher();
      refresher.shouldThrow = new Error('invalid_grant');
      const forwarder = new GmailForwarder({
        credentials,
        client: new StubGmailClient(),
        refresher,
        clock: fixedClock(T_NOW),
      });

      await expect(
        forwarder.forward({
          tenantId: 't1',
          connector: 'gmail',
          tool: 'send',
          input: { to: 'a@b.com', subject: 's', body: 'b' },
          credential: serializeGmailCredential(freshBlob({ expiryEpochMs: T_NOW - 1 })),
        }),
      ).rejects.toThrow('invalid_grant');
    });
  });
});
