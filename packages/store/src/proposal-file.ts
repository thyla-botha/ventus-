import { randomUUID } from 'node:crypto';
import type {
  Proposal,
  ProposalDecision,
  ProposalInput,
  ProposalStatus,
  ProposalStore,
} from './types.js';
import { readJsonFile, writeJsonFile } from './_file-util.js';

interface FileShape {
  version: 1;
  proposals: Proposal[];
}

function emptyState(): FileShape {
  return { version: 1, proposals: [] };
}

// File-backed ProposalStore for dev / single-process use.
//
// Concurrency model: a per-instance promise chain (writeLock) serializes
// read-modify-write cycles so beginExecution, decide, markExecuted, etc.
// are atomic within ONE FileProposalStore. Two stores pointed at the same
// file (different instances or different processes) CAN race and both
// claim the same proposal — file-locking is not provided. Postgres swap
// uses `UPDATE ... WHERE status='approved' RETURNING ...` for cross-process
// atomicity.
export class FileProposalStore implements ProposalStore {
  private writeLock: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<FileShape> {
    const data = await readJsonFile<FileShape | null>(this.path, null);
    if (data && data.version === 1) return data;
    return emptyState();
  }

  private async update(mutate: (state: FileShape) => Proposal): Promise<Proposal> {
    let result: Proposal | undefined;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      result = mutate(state);
      await writeJsonFile(this.path, state);
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    if (!result) throw new Error('mutation produced no proposal');
    return result;
  }

  async create(input: ProposalInput): Promise<Proposal> {
    return this.update((state) => {
      const now = new Date().toISOString();
      const proposal: Proposal = {
        ...input,
        id: randomUUID(),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      state.proposals.push(proposal);
      return proposal;
    });
  }

  async get(id: string): Promise<Proposal | null> {
    const state = await this.load();
    return state.proposals.find((p) => p.id === id) ?? null;
  }

  async list(filter?: {
    tenantId?: string;
    status?: ProposalStatus;
    runId?: string;
    limit?: number;
  }): Promise<Proposal[]> {
    const state = await this.load();
    let out = state.proposals.slice();
    if (filter?.tenantId) out = out.filter((p) => p.tenantId === filter.tenantId);
    if (filter?.status) out = out.filter((p) => p.status === filter.status);
    if (filter?.runId) out = out.filter((p) => p.runId === filter.runId);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter?.limit !== undefined) out = out.slice(0, filter.limit);
    return out;
  }

  async decide(id: string, decision: ProposalDecision): Promise<Proposal> {
    return this.update((state) => {
      const idx = state.proposals.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error(`proposal not found: ${id}`);
      const current = state.proposals[idx]!;
      if (current.status !== 'pending') {
        throw new Error(`proposal ${id} is not pending (status=${current.status})`);
      }
      const next: Proposal = {
        ...current,
        status: decision.verdict === 'approved' || decision.verdict === 'edited'
          ? 'approved'
          : 'rejected',
        decision,
        updatedAt: new Date().toISOString(),
      };
      state.proposals[idx] = next;
      return next;
    });
  }

  async beginExecution(id: string): Promise<Proposal | null> {
    let claimed: Proposal | null = null;
    const next = this.writeLock.then(async () => {
      const state = await this.load();
      const idx = state.proposals.findIndex((p) => p.id === id);
      if (idx === -1) return;
      const current = state.proposals[idx]!;
      if (current.status !== 'approved') return;
      const updated: Proposal = {
        ...current,
        status: 'executing',
        updatedAt: new Date().toISOString(),
      };
      state.proposals[idx] = updated;
      claimed = updated;
      await writeJsonFile(this.path, state);
    });
    this.writeLock = next.catch(() => undefined);
    await next;
    return claimed;
  }

  async markExecuted(id: string): Promise<Proposal> {
    return this.update((state) => {
      const idx = state.proposals.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error(`proposal not found: ${id}`);
      const current = state.proposals[idx]!;
      if (current.status !== 'executing') {
        throw new Error(`proposal ${id} is not executing (status=${current.status})`);
      }
      const next: Proposal = {
        ...current,
        status: 'executed',
        updatedAt: new Date().toISOString(),
      };
      state.proposals[idx] = next;
      return next;
    });
  }

  async markExecutionFailed(id: string): Promise<Proposal> {
    return this.update((state) => {
      const idx = state.proposals.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error(`proposal not found: ${id}`);
      const current = state.proposals[idx]!;
      if (current.status !== 'executing') {
        throw new Error(`proposal ${id} is not executing (status=${current.status})`);
      }
      const next: Proposal = {
        ...current,
        status: 'failed',
        updatedAt: new Date().toISOString(),
      };
      state.proposals[idx] = next;
      return next;
    });
  }
}
