import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuditStore } from './audit-file.js';
import type { AuditIntentRecord } from './types.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

function intent(overrides: Partial<Omit<AuditIntentRecord, 'id' | 'proposedAt'>> = {}) {
  return {
    tenantId: TENANT_A,
    runId: 'run-1',
    stepNo: 0,
    actorType: 'agent' as const,
    actorId: 'agent-1',
    action: 'tool:create_proposal',
    ...overrides,
  };
}

describe('FileAuditStore', () => {
  let dir: string;
  let store: FileAuditStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-audit-'));
    store = new FileAuditStore(join(dir, 'audit.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('recordIntent / recordOutcome', () => {
    it('assigns id and proposedAt on intent', async () => {
      const i = await store.recordIntent(intent());
      expect(i.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(i.proposedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('assigns id and recordedAt on outcome', async () => {
      const i = await store.recordIntent(intent());
      const o = await store.recordOutcome({
        intentId: i.id,
        tenantId: TENANT_A,
        status: 'executed',
        result: { ok: true },
      });
      expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(o.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('listIntents / listOutcomes', () => {
    it('scopes by tenant and sorts newest first', async () => {
      const a = await store.recordIntent(intent({ tenantId: TENANT_A }));
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.recordIntent(intent({ tenantId: TENANT_A }));
      await store.recordIntent(intent({ tenantId: TENANT_B }));

      const onlyA = await store.listIntents(TENANT_A);
      expect(onlyA.map((i) => i.id)).toEqual([b.id, a.id]);
    });
  });

  describe('listAuditTrail', () => {
    it('joins intent rows with their matching outcomes', async () => {
      const i = await store.recordIntent(
        intent({ resourceType: 'proposal', resourceId: 'p1' }),
      );
      await store.recordOutcome({
        intentId: i.id,
        tenantId: TENANT_A,
        status: 'executed',
        result: { ok: true },
      });

      const trail = await store.listAuditTrail({ tenantId: TENANT_A });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(i.id);
      expect(trail[0]!.outcome?.status).toBe('executed');
    });

    it('surfaces orphan intents (no outcome) with outcome=null', async () => {
      const i = await store.recordIntent(intent());
      const trail = await store.listAuditTrail({ tenantId: TENANT_A });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(i.id);
      expect(trail[0]!.outcome).toBeNull();
    });

    it('filters by tenantId — never leaks across tenants', async () => {
      const a = await store.recordIntent(intent({ tenantId: TENANT_A }));
      await store.recordIntent(intent({ tenantId: TENANT_B }));
      const trail = await store.listAuditTrail({ tenantId: TENANT_A });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(a.id);
    });

    it('never pairs an intent with an outcome from a different tenant', async () => {
      // Codex flagged: the outcome-map join must also be tenant-scoped.
      // Without that, an outcome row with the same intentId but a different
      // tenantId could mask an orphan when listAuditTrail is called for
      // the original tenant. Construct that exact scenario: write an
      // intent for tenant A, then write an outcome referencing that
      // intentId BUT carrying tenant B's tenantId. The trail for tenant A
      // must show the intent as orphan (outcome=null), not paired with B's
      // cross-tenant outcome.
      const aIntent = await store.recordIntent(intent({ tenantId: TENANT_A }));
      await store.recordOutcome({
        intentId: aIntent.id,
        tenantId: TENANT_B,
        status: 'executed',
        durationMs: 1,
      });
      const trail = await store.listAuditTrail({ tenantId: TENANT_A });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(aIntent.id);
      expect(trail[0]!.outcome).toBeNull();
    });

    it('filters by resourceType and resourceId', async () => {
      const target = await store.recordIntent(
        intent({ resourceType: 'proposal', resourceId: 'p1' }),
      );
      await store.recordIntent(intent({ resourceType: 'proposal', resourceId: 'p2' }));
      await store.recordIntent(intent({ resourceType: 'run', resourceId: 'r1' }));

      const trail = await store.listAuditTrail({
        tenantId: TENANT_A,
        resourceType: 'proposal',
        resourceId: 'p1',
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(target.id);
    });

    it('filters by runId', async () => {
      const target = await store.recordIntent(intent({ runId: 'run-target' }));
      await store.recordIntent(intent({ runId: 'run-other' }));
      const trail = await store.listAuditTrail({
        tenantId: TENANT_A,
        runId: 'run-target',
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.intent.id).toBe(target.id);
    });

    it('respects limit and sorts newest first', async () => {
      const a = await store.recordIntent(intent());
      await new Promise((r) => setTimeout(r, 5));
      const b = await store.recordIntent(intent());
      await new Promise((r) => setTimeout(r, 5));
      const c = await store.recordIntent(intent());

      const trail = await store.listAuditTrail({ tenantId: TENANT_A, limit: 2 });
      expect(trail.map((r) => r.intent.id)).toEqual([c.id, b.id]);
      expect(a.id).toBeDefined();
    });

    it('handles many intents with one outcome each correctly (no cross-talk)', async () => {
      const i1 = await store.recordIntent(intent());
      const i2 = await store.recordIntent(intent());
      await store.recordOutcome({
        intentId: i1.id,
        tenantId: TENANT_A,
        status: 'executed',
        result: { a: 1 },
      });
      await store.recordOutcome({
        intentId: i2.id,
        tenantId: TENANT_A,
        status: 'failed',
        errorText: 'boom',
      });

      const trail = await store.listAuditTrail({ tenantId: TENANT_A });
      const byIntent = new Map(trail.map((r) => [r.intent.id, r.outcome]));
      expect(byIntent.get(i1.id)?.status).toBe('executed');
      expect(byIntent.get(i2.id)?.status).toBe('failed');
    });
  });

  describe('concurrent writes', () => {
    it('serializes parallel intent writes without dropping rows', async () => {
      await Promise.all(
        Array.from({ length: 20 }, () => store.recordIntent(intent())),
      );
      const all = await store.listIntents(TENANT_A);
      expect(all).toHaveLength(20);
      expect(new Set(all.map((i) => i.id)).size).toBe(20);
    });
  });
});
