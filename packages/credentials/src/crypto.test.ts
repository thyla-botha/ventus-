import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
} from './crypto.js';

// Per-tenant credential crypto. These tests are the security contract for
// every OAuth token stored in the system; treat regressions here as
// release-blocking.

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

let priorMaster: string | undefined;

beforeEach(() => {
  priorMaster = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  process.env.VENTUS_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
});

afterEach(() => {
  if (priorMaster === undefined) delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  else process.env.VENTUS_CREDENTIAL_MASTER_KEY = priorMaster;
});

describe('encryptCredential / decryptCredential', () => {
  it('round-trips plaintext under the same tenant and master key', () => {
    const plaintext = 'ya29.a0ARrdaM-supersecret-google-oauth-token';
    const blob = encryptCredential(TENANT_A, plaintext);
    expect(blob.version).toBe(1);
    expect(blob.data).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(blob.data).not.toContain(plaintext);
    const back = decryptCredential(TENANT_A, blob);
    expect(back).toBe(plaintext);
  });

  it('produces a different ciphertext on each call (IV is random)', () => {
    // GCM under a fixed key + same plaintext + different IV must not
    // collide. Otherwise an attacker who sees two equal ciphertexts
    // learns that the plaintexts were equal too.
    const plaintext = 'same plaintext both times';
    const a = encryptCredential(TENANT_A, plaintext);
    const b = encryptCredential(TENANT_A, plaintext);
    expect(a.data).not.toBe(b.data);
    expect(decryptCredential(TENANT_A, a)).toBe(plaintext);
    expect(decryptCredential(TENANT_A, b)).toBe(plaintext);
  });

  it('does NOT decrypt a blob with the wrong tenantId (cross-tenant isolation)', () => {
    // CRITICAL: tenant A's ciphertext must be opaque to tenant B's
    // subkey, even though both derive from the same master. This is the
    // foundation of the per-tenant key story; a bug that mis-routes the
    // tenantId to deriveSubkey would silently leak across tenants.
    const blob = encryptCredential(TENANT_A, 'tenant-a-only secret');
    expect(() => decryptCredential(TENANT_B, blob)).toThrow(CredentialCryptoError);
  });

  it('rejects a tampered ciphertext (GCM auth tag check)', () => {
    const blob = encryptCredential(TENANT_A, 'sensitive');
    // Flip one byte in the middle of the base64 blob — GCM should
    // detect the tamper and refuse to decrypt.
    const buf = Buffer.from(blob.data, 'base64');
    buf[buf.length - 5]! ^= 0x01;
    const tampered = { ...blob, data: buf.toString('base64') };
    expect(() => decryptCredential(TENANT_A, tampered)).toThrow(CredentialCryptoError);
  });

  it('rejects a blob produced under a different master key', () => {
    const blob = encryptCredential(TENANT_A, 'kept under key 1');
    // Rotate the master key — same tenantId, but the derived subkey is
    // completely different now. Decrypt must fail closed.
    process.env.VENTUS_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64');
    expect(() => decryptCredential(TENANT_A, blob)).toThrow(CredentialCryptoError);
  });

  it('throws a typed error when master key is unset', () => {
    delete process.env.VENTUS_CREDENTIAL_MASTER_KEY;
    expect(() => encryptCredential(TENANT_A, 'x')).toThrow(
      /VENTUS_CREDENTIAL_MASTER_KEY not set/,
    );
  });

  it('throws when master key is the wrong length', () => {
    process.env.VENTUS_CREDENTIAL_MASTER_KEY = Buffer.from('too short').toString('base64');
    expect(() => encryptCredential(TENANT_A, 'x')).toThrow(/must decode to 32 bytes/);
  });

  it('rejects a blob with an unsupported version', () => {
    const blob = encryptCredential(TENANT_A, 'fine');
    const futureBlob = { ...blob, version: 999 };
    expect(() => decryptCredential(TENANT_A, futureBlob)).toThrow(
      /unsupported credential blob version/,
    );
  });

  it('rejects a truncated blob', () => {
    const blob = encryptCredential(TENANT_A, 'fine');
    const tiny = { ...blob, data: Buffer.from('shortbytes').toString('base64') };
    expect(() => decryptCredential(TENANT_A, tiny)).toThrow(CredentialCryptoError);
  });

  it('handles long plaintexts (e.g. multi-line refresh tokens)', () => {
    // OAuth refresh tokens can be hundreds of bytes; verify the cipher
    // chunking + final tag handle them. Use ~4KB to mimic a worst-case
    // composite credential blob (token + scopes + provider metadata).
    const plaintext = 'long-token-' + 'x'.repeat(4096);
    const blob = encryptCredential(TENANT_A, plaintext);
    expect(decryptCredential(TENANT_A, blob)).toBe(plaintext);
  });
});
