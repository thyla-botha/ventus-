import { randomUUID } from 'node:crypto';
import type {
  AuditIntentRecord,
  AuditOutcomeRecord,
  AuditStore,
  AuditTrailFilter,
  AuditTrailRow,
} from './types.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

// Thrown by recordOutcome when (intentId, tenantId) does not match any
// existing intent row. The Postgres+RLS swap turns this into a foreign
// key + tenant-scoped policy enforcement; until then, the file store
// performs the equivalent check inside the same write lock.
export class AuditOutcomeReferentialError extends Error {
  readonly code = 'AUDIT_OUTCOME_REFERENTIAL_ERROR';
  constructor(
    readonly intentId: string,
    readonly tenantId: string,
  ) {
    super(
      `recordOutcome: no intent ${intentId} for tenant ${tenantId} (cross-tenant or unknown intent)`,
    );
    this.name = 'AuditOutcomeReferentialError';
  }
}

interface FileShape {
  version: 1;
  intents: AuditIntentRecord[];
  outcomes: AuditOutcomeRecord[];
}

function emptyState(): FileShape {
  return { version: 1, intents: [], outcomes: [] };
}

export class FileAuditStore implements AuditStore {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    const data = await readJsonFile<FileShape | null>(this.path, null);
    if (data && data.version === 1) return data;
    return emptyState();
  }

  private async mutate<T>(fn: (state: FileShape) => T): Promise<T> {
    let result: T | undefined;
    let captured = false;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      result = fn(state);
      captured = true;
      await writeJsonFile(this.path, state);
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    if (!captured) throw new Error('audit mutation produced no result');
    return result as T;
  }

  async recordIntent(
    input: Omit<AuditIntentRecord, 'id' | 'proposedAt'>,
  ): Promise<AuditIntentRecord> {
    return this.mutate((state) => {
      const rec: AuditIntentRecord = {
        ...input,
        id: randomUUID(),
        proposedAt: new Date().toISOString(),
      };
      state.intents.push(rec);
      return rec;
    });
  }

  async recordOutcome(
    input: Omit<AuditOutcomeRecord, 'id' | 'recordedAt'>,
  ): Promise<AuditOutcomeRecord> {
    // CODEX HIGH-5: enforce referential integrity inside the write lock.
    // The intent referenced by intentId MUST exist AND MUST belong to the
    // same tenant. Without this check, an outcome row could reference an
    // intent that never existed (orphan) or — worse — an intent owned by
    // a different tenant (cross-tenant audit pollution). The Postgres
    // swap will replace this with a (intentId, tenantId) composite FK.
    return this.mutate((state) => {
      const matched = state.intents.find(
        (i) => i.id === input.intentId && i.tenantId === input.tenantId,
      );
      if (!matched) {
        throw new AuditOutcomeReferentialError(input.intentId, input.tenantId);
      }
      const rec: AuditOutcomeRecord = {
        ...input,
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
      };
      state.outcomes.push(rec);
      return rec;
    });
  }

  async listIntents(tenantId: string): Promise<AuditIntentRecord[]> {
    const state = await this.load();
    return state.intents
      .filter((i) => i.tenantId === tenantId)
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  }

  async listOutcomes(tenantId: string): Promise<AuditOutcomeRecord[]> {
    const state = await this.load();
    return state.outcomes
      .filter((o) => o.tenantId === tenantId)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async listAuditTrail(filter: AuditTrailFilter): Promise<AuditTrailRow[]> {
    const state = await this.load();
    // Tenant-scope the outcome map BEFORE the join. An outcome row whose
    // tenantId differs from the requested tenant must not be paired with a
    // tenant-scoped intent, even if intentIds collide (UUIDs make this
    // unlikely but the isolation invariant must not depend on that). Codex
    // flagged: under Postgres+RLS this would be enforced by the policy, but
    // on the file store the map is built in JS so we have to scope manually.
    const outcomesByIntent = new Map<string, AuditOutcomeRecord>();
    for (const o of state.outcomes) {
      if (o.tenantId !== filter.tenantId) continue;
      outcomesByIntent.set(o.intentId, o);
    }

    let intents = state.intents.filter((i) => i.tenantId === filter.tenantId);
    if (filter.resourceType !== undefined) {
      intents = intents.filter((i) => i.resourceType === filter.resourceType);
    }
    if (filter.resourceId !== undefined) {
      intents = intents.filter((i) => i.resourceId === filter.resourceId);
    }
    if (filter.runId !== undefined) {
      intents = intents.filter((i) => i.runId === filter.runId);
    }

    intents.sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
    if (filter.limit !== undefined) intents = intents.slice(0, filter.limit);

    return intents.map((intent) => ({
      intent,
      outcome: outcomesByIntent.get(intent.id) ?? null,
    }));
  }
}
