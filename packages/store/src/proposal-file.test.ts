import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileProposalStore } from './proposal-file.js';
import type { ProposalInput } from './types.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

function input(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    tenantId: TENANT_A,
    runId: 'run-1',
    agentId: 'agent-1',
    actionType: 'draft_email_reply',
    payload: { to: 'a@b.com', subject: 's', body: 'b' },
    ...overrides,
  };
}

describe('FileProposalStore', () => {
  let dir: string;
  let store: FileProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-proposal-'));
    store = new FileProposalStore(join(dir, 'proposals.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('returns a pending proposal with id and timestamps', async () => {
      const p = await store.create(input());
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(p.status).toBe('pending');
      expect(p.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(p.updatedAt).toBe(p.createdAt);
      expect(p.decision).toBeUndefined();
    });

    it('persists across instances (file-backed)', async () => {
      const created = await store.create(input());
      const fresh = new FileProposalStore(join(dir, 'proposals.json'));
      const reloaded = await fresh.get(created.id);
      expect(reloaded?.id).toBe(created.id);
    });
  });

  describe('get', () => {
    it('returns null for unknown id', async () => {
      expect(await store.get('does-not-exist')).toBeNull();
    });
  });

  describe('list', () => {
    it('filters by tenantId', async () => {
      await store.create(input({ tenantId: TENANT_A }));
      await store.create(input({ tenantId: TENANT_B }));
      const onlyA = await store.list({ tenantId: TENANT_A });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0]!.tenantId).toBe(TENANT_A);
    });

    it('filters by status', async () => {
      const a = await store.create(input());
      await store.create(input());
      await store.decide(a.id, {
        approverId: 'u-1',
        verdict: 'approved',
        decidedAt: new Date().toISOString(),
      });
      const pending = await store.list({ status: 'pending' });
      const approved = await store.list({ status: 'approved' });
      expect(pending).toHaveLength(1);
      expect(approved).toHaveLength(1);
      expect(approved[0]!.id).toBe(a.id);
    });

    it('sorts newest first', async () => {
      const a = await store.create(input());
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.create(input());
      const all = await store.list();
      expect(all.map((p) => p.id)).toEqual([b.id, a.id]);
    });

    it('respects limit', async () => {
      await store.create(input());
      await store.create(input());
      await store.create(input());
      const out = await store.list({ limit: 2 });
      expect(out).toHaveLength(2);
    });
  });

  describe('decide', () => {
    it('flips pending → approved on verdict=approved', async () => {
      const p = await store.create(input());
      const decision = {
        approverId: 'u-1',
        verdict: 'approved' as const,
        decidedAt: new Date().toISOString(),
      };
      const next = await store.decide(p.id, decision);
      expect(next.status).toBe('approved');
      expect(next.decision).toEqual(decision);
      expect(next.updatedAt >= p.updatedAt).toBe(true);
    });

    it('flips pending → rejected on verdict=rejected', async () => {
      const p = await store.create(input());
      const next = await store.decide(p.id, {
        approverId: 'u-1',
        verdict: 'rejected',
        comment: 'no',
        decidedAt: new Date().toISOString(),
      });
      expect(next.status).toBe('rejected');
    });

    it('treats verdict=edited as approved with editedPayload preserved', async () => {
      const p = await store.create(input());
      const edited = { to: 'changed@x.com', subject: 's', body: 'b' };
      const next = await store.decide(p.id, {
        approverId: 'u-1',
        verdict: 'edited',
        editedPayload: edited,
        decidedAt: new Date().toISOString(),
      });
      expect(next.status).toBe('approved');
      expect(next.decision?.verdict).toBe('edited');
      expect(next.decision?.editedPayload).toEqual(edited);
      expect(next.payload).toEqual(input().payload);
    });

    it('rejects non-pending proposals', async () => {
      const p = await store.create(input());
      await store.decide(p.id, {
        approverId: 'u-1',
        verdict: 'approved',
        decidedAt: new Date().toISOString(),
      });
      await expect(
        store.decide(p.id, {
          approverId: 'u-1',
          verdict: 'rejected',
          decidedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/not pending/);
    });

    it('throws when proposal is missing', async () => {
      await expect(
        store.decide('missing-id', {
          approverId: 'u-1',
          verdict: 'approved',
          decidedAt: new Date().toISOString(),
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe('beginExecution + markExecuted', () => {
    async function approveOne() {
      const p = await store.create(input());
      await store.decide(p.id, {
        approverId: 'u-1',
        verdict: 'approved',
        decidedAt: new Date().toISOString(),
      });
      return p;
    }

    it('beginExecution flips approved → executing and returns the proposal', async () => {
      const p = await approveOne();
      const claimed = await store.beginExecution(p.id);
      expect(claimed?.status).toBe('executing');
      expect(claimed?.id).toBe(p.id);
    });

    it('beginExecution returns null when proposal is not approved', async () => {
      const p = await store.create(input());
      expect(await store.beginExecution(p.id)).toBeNull();
    });

    it('beginExecution returns null when proposal is missing', async () => {
      expect(await store.beginExecution('nope')).toBeNull();
    });

    it('beginExecution is atomic — only one concurrent claim succeeds', async () => {
      const p = await approveOne();
      const results = await Promise.all([
        store.beginExecution(p.id),
        store.beginExecution(p.id),
        store.beginExecution(p.id),
      ]);
      const claimed = results.filter((r) => r !== null);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.status).toBe('executing');
    });

    it('markExecuted flips executing → executed', async () => {
      const p = await approveOne();
      await store.beginExecution(p.id);
      const done = await store.markExecuted(p.id);
      expect(done.status).toBe('executed');
    });

    it('markExecuted refuses when proposal is still approved (must claim first)', async () => {
      const p = await approveOne();
      await expect(store.markExecuted(p.id)).rejects.toThrow(/not executing/);
    });

    it('markExecuted refuses on a pending proposal', async () => {
      const p = await store.create(input());
      await expect(store.markExecuted(p.id)).rejects.toThrow(/not executing/);
    });
  });

  describe('markExecutionFailed', () => {
    it('flips executing → failed', async () => {
      const p = await store.create(input());
      await store.decide(p.id, {
        approverId: 'u-1',
        verdict: 'approved',
        decidedAt: new Date().toISOString(),
      });
      await store.beginExecution(p.id);
      const failed = await store.markExecutionFailed(p.id);
      expect(failed.status).toBe('failed');
    });

    it('refuses to fail a proposal that is not executing', async () => {
      const p = await store.create(input());
      await expect(store.markExecutionFailed(p.id)).rejects.toThrow(/not executing/);
    });
  });

  describe('concurrent writes', () => {
    it('serializes parallel creates without losing rows', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.create(input())),
      );
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(20);
      const all = await store.list();
      expect(all).toHaveLength(20);
    });
  });
});
