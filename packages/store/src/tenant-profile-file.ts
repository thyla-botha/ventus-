import { createHash } from 'node:crypto';
import {
  MAX_TENANT_PROFILE_LEN,
  MAX_TENANT_RUNTIME_FIELD_LEN,
  type TenantProfile,
  type TenantProfileStore,
  type TenantRuntimeConfig,
} from './types.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

// Rejects any control or line-separator character: C0 controls (0x00-0x1F,
// excluding nothing here — even tab is too risky inside a stable
// identifier), DEL (0x7F), C1 controls (0x80-0x9F), and Unicode line
// separators U+2028/U+2029. Provider/model strings must be safe to embed
// in logs, audit rows, URL/header values, and JSON without splitting
// lines or smuggling fields. Codex round-9 MEDIUM.
const UNSAFE_CHARS_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/u;

function assertSafeRuntimeField(name: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`tenant_profile runtime.${name} must be a string`);
  }
  // Check unsafe chars against the *original* value — trim() also strips \n,
  // \r, U+2028/U+2029 as line terminators, so a boundary case like
  // 'ollama\n' would silently pass if we tested the trimmed string.
  if (UNSAFE_CHARS_RE.test(value)) {
    throw new Error(
      `tenant_profile runtime.${name} contains control or line-separator characters`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`tenant_profile runtime.${name} must be a non-empty string`);
  }
  if (trimmed.length > MAX_TENANT_RUNTIME_FIELD_LEN) {
    throw new Error(
      `tenant_profile runtime.${name} exceeds ${MAX_TENANT_RUNTIME_FIELD_LEN} chars (got ${trimmed.length})`,
    );
  }
}

interface FileShape {
  version: 1;
  // Indexed by tenantId for O(1) lookup. Tenants without a profile simply
  // don't appear here, which is the natural "no profile" signal for
  // TenantProfileStore.get().
  profiles: Record<string, TenantProfile>;
}

function emptyState(): FileShape {
  return { version: 1, profiles: {} };
}

// File-backed TenantProfileStore. Same concurrency model as the other file
// stores: a per-instance writeLock serialises RMW cycles. The profile is
// mutable in place — a fresh write overwrites the prior body and updates
// contentHash/updatedAt. There is intentionally no history table here yet;
// the immutable provenance lives on each Run row via tenantProfileHash.
export class FileTenantProfileStore implements TenantProfileStore {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    const data = await readJsonFile<FileShape | null>(this.path, null);
    if (data && data.version === 1) return data;
    return emptyState();
  }

  async get(tenantId: string): Promise<TenantProfile | null> {
    const state = await this.load();
    return state.profiles[tenantId] ?? null;
  }

  async list(): Promise<TenantProfile[]> {
    const state = await this.load();
    return Object.values(state.profiles);
  }

  async set(
    tenantId: string,
    body: string,
    by: { updatedBy?: string; at?: string },
  ): Promise<TenantProfile> {
    const trimmed = body.trim();
    if (trimmed.length > MAX_TENANT_PROFILE_LEN) {
      throw new Error(
        `tenant_profile body exceeds ${MAX_TENANT_PROFILE_LEN} chars (got ${trimmed.length})`,
      );
    }
    // Hash the body bytes (utf8 encoding). Empty body still gets a stable
    // hash so callers can treat "empty profile" as a distinct snapshot from
    // "no profile" without special-casing on the consumer side.
    const contentHash = createHash('sha256').update(trimmed, 'utf8').digest('hex');
    let result: TenantProfile | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      // Preserve any existing runtime override across body writes — body
      // and runtime config are independently managed.
      const prior = state.profiles[tenantId];
      const profile: TenantProfile = {
        tenantId,
        body: trimmed,
        contentHash,
        updatedAt: by.at ?? new Date().toISOString(),
        updatedBy: by.updatedBy,
        runtime: prior?.runtime,
        runtimeUpdatedAt: prior?.runtimeUpdatedAt,
        runtimeUpdatedBy: prior?.runtimeUpdatedBy,
      };
      state.profiles[tenantId] = profile;
      await writeJsonFile(this.path, state);
      result = profile;
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    if (!result) throw new Error('tenant_profile write produced no result');
    return result;
  }

  async setRuntime(
    tenantId: string,
    runtime: TenantRuntimeConfig | null,
    by: { updatedBy?: string; at?: string },
  ): Promise<TenantProfile> {
    if (runtime !== null) {
      assertSafeRuntimeField('provider', runtime.provider);
      assertSafeRuntimeField('model', runtime.model);
    }
    let result: TenantProfile | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      const now = by.at ?? new Date().toISOString();
      const prior = state.profiles[tenantId];
      // Create an empty-body profile if none exists yet — symmetric with
      // set() creating a profile against an absent tenant. The empty body
      // still hashes to a stable value.
      const body = prior?.body ?? '';
      const contentHash =
        prior?.contentHash ??
        createHash('sha256').update(body, 'utf8').digest('hex');
      const profile: TenantProfile = {
        tenantId,
        body,
        contentHash,
        updatedAt: prior?.updatedAt ?? now,
        updatedBy: prior?.updatedBy,
        runtime: runtime
          ? {
              provider: runtime.provider.trim(),
              model: runtime.model.trim(),
            }
          : undefined,
        runtimeUpdatedAt: now,
        runtimeUpdatedBy: by.updatedBy,
      };
      state.profiles[tenantId] = profile;
      await writeJsonFile(this.path, state);
      result = profile;
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    if (!result) throw new Error('tenant_profile runtime write produced no result');
    return result;
  }
}
