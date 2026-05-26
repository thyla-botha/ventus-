import { createHash } from 'node:crypto';
import {
  MAX_TENANT_PROFILE_LEN,
  type TenantProfile,
  type TenantProfileStore,
} from './types.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

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
      const profile: TenantProfile = {
        tenantId,
        body: trimmed,
        contentHash,
        updatedAt: by.at ?? new Date().toISOString(),
        updatedBy: by.updatedBy,
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
}
