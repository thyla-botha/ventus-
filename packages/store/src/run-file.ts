import { randomUUID } from 'node:crypto';
import type {
  RunCompletion,
  RunInput,
  RunRecord,
  RunStatus,
  RunStore,
} from './types.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

interface FileShape {
  version: 1;
  runs: RunRecord[];
}

function emptyState(): FileShape {
  return { version: 1, runs: [] };
}

// File-backed RunStore for dev / single-process use. Same concurrency model
// as FileProposalStore: a per-instance promise chain serializes RMW cycles.
// Cross-process atomicity arrives with the Postgres swap.
export class FileRunStore implements RunStore {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    const data = await readJsonFile<FileShape | null>(this.path, null);
    if (data && data.version === 1) return data;
    return emptyState();
  }

  private async update(mutate: (state: FileShape) => RunRecord): Promise<RunRecord> {
    let result: RunRecord | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      result = mutate(state);
      await writeJsonFile(this.path, state);
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    if (!result) throw new Error('mutation produced no run');
    return result;
  }

  async create(input: RunInput): Promise<RunRecord> {
    return this.update((state) => {
      const run: RunRecord = {
        ...input,
        id: randomUUID(),
        status: 'running',
        startedAt: new Date().toISOString(),
      };
      state.runs.push(run);
      return run;
    });
  }

  async get(id: string): Promise<RunRecord | null> {
    const state = await this.load();
    return state.runs.find((r) => r.id === id) ?? null;
  }

  async list(filter?: {
    tenantId?: string;
    status?: RunStatus;
    agentId?: string;
    limit?: number;
  }): Promise<RunRecord[]> {
    const state = await this.load();
    let out = state.runs.slice();
    if (filter?.tenantId) out = out.filter((r) => r.tenantId === filter.tenantId);
    if (filter?.status) out = out.filter((r) => r.status === filter.status);
    if (filter?.agentId) out = out.filter((r) => r.agentId === filter.agentId);
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  async requestCancel(
    id: string,
    by: { requestedBy: string; at?: string },
  ): Promise<RunRecord | null> {
    // Inline the writeLock dance because update() can't express "no-op + return
    // existing row" (it throws on missing mutation, and we want a non-throwing
    // 'already cancelled' path that still serialises against concurrent writes).
    let result: RunRecord | null | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      const idx = state.runs.findIndex((r) => r.id === id);
      if (idx === -1) {
        result = null;
        return;
      }
      const current = state.runs[idx]!;
      // Already cancelled, OR already terminal: leave the row alone but return
      // it so the caller can distinguish "I cancelled it" (200) from "not
      // found" (404). Caller can compare cancelRequestedAt to detect dupes.
      if (current.cancelRequestedAt || current.status !== 'running') {
        result = current;
        return;
      }
      const updated: RunRecord = {
        ...current,
        cancelRequestedAt: by.at ?? new Date().toISOString(),
        cancelRequestedBy: by.requestedBy,
      };
      state.runs[idx] = updated;
      await writeJsonFile(this.path, state);
      result = updated;
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    return result ?? null;
  }

  async heartbeat(id: string, at?: string): Promise<RunRecord | null> {
    // No-op-and-return semantics on terminal rows: the reaper can be racing
    // the loop's own complete() write, and we don't want every late
    // heartbeat to log/throw. Returns null only when the row genuinely
    // doesn't exist (or has been deleted).
    let result: RunRecord | null | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      const idx = state.runs.findIndex((r) => r.id === id);
      if (idx === -1) {
        result = null;
        return;
      }
      const current = state.runs[idx]!;
      if (current.status !== 'running') {
        result = current;
        return;
      }
      const updated: RunRecord = {
        ...current,
        lastHeartbeatAt: at ?? new Date().toISOString(),
      };
      state.runs[idx] = updated;
      await writeJsonFile(this.path, state);
      result = updated;
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    return result ?? null;
  }

  async complete(id: string, completion: RunCompletion): Promise<RunRecord> {
    return this.update((state) => {
      const idx = state.runs.findIndex((r) => r.id === id);
      if (idx === -1) throw new Error(`run not found: ${id}`);
      const current = state.runs[idx]!;
      if (current.status !== 'running') {
        throw new Error(`run ${id} is not running (status=${current.status})`);
      }
      const next: RunRecord = {
        ...current,
        status: completion.status,
        endedAt: new Date().toISOString(),
        totalCostMicros: completion.totalCostMicros,
        proposalCount: completion.proposalCount,
        finalText: completion.finalText,
        haltReason: completion.haltReason,
        errorText: completion.errorText,
      };
      state.runs[idx] = next;
      return next;
    });
  }

  async reapIfStale(
    id: string,
    opts: { staleAsOf: string; completion: RunCompletion },
  ): Promise<RunRecord | null> {
    // Closes the race window between the reaper's snapshot of state and the
    // actual write. The reaper observed a stale heartbeat at staleAsOf; by
    // the time we hold the writeLock, the loop may have queued a fresher
    // heartbeat that landed first. We re-check under the lock and bail
    // (return null) when the row no longer matches "still stale, still
    // running" — protecting a live loop from being killed by a snapshot
    // that lost a race.
    const staleAsOfMs = new Date(opts.staleAsOf).getTime();
    // Defensive: a NaN watermark would make the row-timestamp comparison
    // (`reference > staleAsOfMs`) always false, silently authorising every
    // reap. Refuse to act rather than guess.
    if (!Number.isFinite(staleAsOfMs)) {
      throw new Error(`reapIfStale: malformed staleAsOf=${opts.staleAsOf}`);
    }
    let result: RunRecord | null | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      const idx = state.runs.findIndex((r) => r.id === id);
      if (idx === -1) {
        result = null;
        return;
      }
      const current = state.runs[idx]!;
      if (current.status !== 'running') {
        result = null;
        return;
      }
      const reference = current.lastHeartbeatAt ?? current.startedAt;
      const referenceMs = new Date(reference).getTime();
      // A row with garbage timestamps is a data integrity bug, not a stale
      // run. Reaping it would obscure the underlying corruption; surface it
      // to the caller (the reaper logs + skips it).
      if (!Number.isFinite(referenceMs)) {
        throw new Error(
          `reapIfStale: malformed liveness timestamp on run ${id} (lastHeartbeatAt=${current.lastHeartbeatAt}, startedAt=${current.startedAt})`,
        );
      }
      if (referenceMs > staleAsOfMs) {
        // A fresh heartbeat landed between the reaper's snapshot and now —
        // the loop is alive. Don't reap.
        result = null;
        return;
      }
      const reaped: RunRecord = {
        ...current,
        status: opts.completion.status,
        endedAt: new Date().toISOString(),
        totalCostMicros: opts.completion.totalCostMicros,
        proposalCount: opts.completion.proposalCount,
        finalText: opts.completion.finalText,
        haltReason: opts.completion.haltReason,
        errorText: opts.completion.errorText,
      };
      state.runs[idx] = reaped;
      await writeJsonFile(this.path, state);
      result = reaped;
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    return result ?? null;
  }
}
