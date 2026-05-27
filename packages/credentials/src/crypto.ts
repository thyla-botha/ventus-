import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Per-tenant credential encryption.
//
// Threat model: an attacker who reads the on-disk credential store should
// learn NOTHING about the OAuth tokens inside. A misconfigured backup, a
// stolen disk image, a leaked git commit of the store file — none of these
// can yield a usable token.
//
// Design:
//   - Master key: 32 random bytes, base64-encoded, supplied via env
//     (VENTUS_CREDENTIAL_MASTER_KEY). Treated like a database password.
//   - Per-tenant subkey: HKDF-SHA256(master, salt=tenantId, info='ventus
//     /credential/v1') -> 32 bytes. Deterministic, so re-deriving from the
//     master + tenantId always yields the same subkey. No KEK/DEK split:
//     this scheme is for OAuth tokens, not high-volume bulk data, and a
//     hierarchical wrap adds operational surface (key-store, rotation
//     dance) without strengthening the threat model.
//   - Cipher: AES-256-GCM. 12-byte random IV. The 16-byte auth tag is
//     stored alongside the ciphertext (in the same blob), so a flipped
//     bit on disk fails decrypt rather than silently flipping the
//     plaintext.
//
// Rotation: changing the master key invalidates all existing blobs. The
// tenant.encryption_key_id column (see packages/db/src/types.ts) is the
// hook for migrating to a new master without downtime — out of scope here
// (no production tenants yet), but the BLOB_VERSION below is the marker
// future migrations key off.

const BLOB_VERSION = 1;
const HKDF_INFO = new TextEncoder().encode('ventus/credential/v1');
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

function getMasterKey(): Buffer {
  const raw = process.env.VENTUS_CREDENTIAL_MASTER_KEY;
  if (!raw) {
    throw new CredentialCryptoError(
      'VENTUS_CREDENTIAL_MASTER_KEY not set; refusing to encrypt/decrypt credentials',
    );
  }
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `VENTUS_CREDENTIAL_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return decoded;
}

function deriveSubkey(master: Buffer, tenantId: string): Buffer {
  // HKDF with the tenantId as salt domain-separates each tenant. If the
  // master leaks (operator pager / KMS misconfig) every tenant's tokens
  // are exposed — but more importantly, a bug that mis-routes tenant A's
  // ciphertext to tenant B's subkey fails decrypt loudly instead of
  // returning corrupted plaintext.
  const salt = new TextEncoder().encode(tenantId);
  const derived = hkdfSync('sha256', master, salt, HKDF_INFO, KEY_BYTES);
  return Buffer.from(derived);
}

// Wire format: v1 | iv(12) | tag(16) | ciphertext(*). Stored base64-encoded
// in the file row so a JSON dump remains human-eyeballable as a blob (no
// binary surprises) without sprawling the schema.
export interface EncryptedBlob {
  version: number;
  // base64-encoded combined IV + tag + ciphertext.
  data: string;
}

export function encryptCredential(tenantId: string, plaintext: string): EncryptedBlob {
  const master = getMasterKey();
  const subkey = deriveSubkey(master, tenantId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', subkey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: BLOB_VERSION,
    data: Buffer.concat([iv, tag, ct]).toString('base64'),
  };
}

export function decryptCredential(tenantId: string, blob: EncryptedBlob): string {
  if (blob.version !== BLOB_VERSION) {
    throw new CredentialCryptoError(
      `unsupported credential blob version: ${blob.version}; expected ${BLOB_VERSION}`,
    );
  }
  const master = getMasterKey();
  const subkey = deriveSubkey(master, tenantId);
  const buf = Buffer.from(blob.data, 'base64');
  if (buf.length < IV_BYTES + 16 + 1) {
    throw new CredentialCryptoError('credential blob too short to contain iv+tag+ciphertext');
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + 16);
  const ct = buf.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', subkey, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    // GCM throws on tag mismatch — same surface for "wrong tenantId",
    // "tampered ciphertext", and "wrong master key". The caller can't
    // distinguish, by design: leaking which of those failed would help an
    // attacker triangulate.
    const msg = err instanceof Error ? err.message : String(err);
    throw new CredentialCryptoError(`decrypt failed: ${msg}`);
  }
}
