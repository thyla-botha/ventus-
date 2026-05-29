import { describe, expect, it } from 'vitest';
import { PostgresAuditStore } from './audit-postgres.js';
import { AuditOutcomeReferentialError } from './audit-file.js';
import type { PgQuerier, PgTenantRunner } from './postgres-types.js';

interface CapturedCall {
  sql: string;
  values: unknown[];
  tenantId?: string;
}

class StubRunner implements PgTenantRunner {
  calls: CapturedCall[] = [];
  txCount = 0;
  responses: Array<unknown[] | ((sql: string, values: unknown[]) => unknown[] | Promise<unknown[]>)> = [];

  async withTenant<T>(
    ctx: { tenantId: string; userId?: string },
    fn: (sql: PgQuerier) => Promise<T>,
  ): Promise<T> {
    this.txCount++;
    const querier: PgQuerier = (async <U = unknown>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<U[]> => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      this.calls.push({ sql, values, tenantId: ctx.tenantId });
      const next = this.responses.shift();
      if (next === undefined) {
        throw new Error(`StubRunner: no response for: ${sql.slice(0, 80)}`);
      }
      const rows = typeof next === 'function' ? await next(sql, values) : next;
      return rows as U[];
    }) as PgQuerier;
    return fn(querier);
  }
}

const T = '11111111-1111-1111-1111-111111111111';
const T_OTHER = '99999999-9999-9999-9999-999999999999';
const INTENT_ID = '22222222-2222-2222-2222-222222222222';
const OUTCOME_ID = '33333333-3333-3333-3333-333333333333';

describe('PostgresAuditStore', () => {
  it('recordIntent() inserts under tenant scope and returns the row', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          id: INTENT_ID,
          tenant_id: T,
          run_id: null,
          step_no: 1,
          actor_type: 'agent',
          actor_id: null,
          action: 'send_email',
          resource_type: null,
          resource_id: null,
          tool_name: null,
          payload: { to: 'a@b' },
          payload_hash: null,
          context_snapshot_hash: null,
          proposed_at: '2026-05-29T10:00:00.000Z',
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const rec = await store.recordIntent({
      tenantId: T,
      stepNo: 1,
      actorType: 'agent',
      action: 'send_email',
      payload: { to: 'a@b' },
    });
    expect(rec.id).toBe(INTENT_ID);
    expect(rec.action).toBe('send_email');
    expect(rec.payload).toEqual({ to: 'a@b' });
    expect(runner.calls[0]?.sql).toMatch(/INSERT INTO audit_intents/);
    expect(runner.calls[0]?.tenantId).toBe(T);
  });

  it('recordOutcome() succeeds with valid intent + tenant', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          id: OUTCOME_ID,
          intent_id: INTENT_ID,
          tenant_id: T,
          status: 'executed',
          result: { ok: true },
          result_hash: null,
          error_text: null,
          duration_ms: 42,
          cost_usd_micros: null,
          recorded_at: '2026-05-29T10:01:00.000Z',
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const rec = await store.recordOutcome({
      intentId: INTENT_ID,
      tenantId: T,
      status: 'executed',
      result: { ok: true },
      durationMs: 42,
    });
    expect(rec.id).toBe(OUTCOME_ID);
    expect(rec.status).toBe('executed');
    expect(rec.durationMs).toBe(42);
  });

  it('recordOutcome() translates a foreign_key_violation into AuditOutcomeReferentialError', async () => {
    const runner = new StubRunner();
    runner.responses = [
      () => {
        // postgres.js raises an Error-like object with `code === '23503'`
        const e = new Error('insert or update on table "audit_outcomes" violates foreign key constraint') as Error & {
          code: string;
        };
        e.code = '23503';
        throw e;
      },
    ];
    const store = new PostgresAuditStore(runner);
    await expect(
      store.recordOutcome({
        intentId: INTENT_ID,
        tenantId: T_OTHER,
        status: 'executed',
      }),
    ).rejects.toBeInstanceOf(AuditOutcomeReferentialError);
  });

  it('recordOutcome() lets non-FK errors propagate', async () => {
    const runner = new StubRunner();
    runner.responses = [
      () => {
        throw new Error('connection lost');
      },
    ];
    const store = new PostgresAuditStore(runner);
    await expect(
      store.recordOutcome({ intentId: INTENT_ID, tenantId: T, status: 'executed' }),
    ).rejects.toThrow(/connection lost/);
  });

  it('listIntents() returns tenant-scoped rows ordered by proposed_at DESC', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          id: INTENT_ID,
          tenant_id: T,
          run_id: null,
          step_no: 0,
          actor_type: 'agent',
          actor_id: null,
          action: 'a',
          resource_type: null,
          resource_id: null,
          tool_name: null,
          payload: null,
          payload_hash: null,
          context_snapshot_hash: null,
          proposed_at: '2026-05-29T10:00:00.000Z',
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const out = await store.listIntents(T);
    expect(out).toHaveLength(1);
    expect(runner.calls[0]?.sql).toMatch(/FROM audit_intents/);
    expect(runner.calls[0]?.sql).toMatch(/ORDER BY proposed_at DESC/);
    expect(runner.calls[0]?.tenantId).toBe(T);
  });

  it('listOutcomes() returns tenant-scoped rows ordered by recorded_at DESC', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          id: OUTCOME_ID,
          intent_id: INTENT_ID,
          tenant_id: T,
          status: 'executed',
          result: null,
          result_hash: null,
          error_text: null,
          duration_ms: null,
          cost_usd_micros: null,
          recorded_at: '2026-05-29T11:00:00.000Z',
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const out = await store.listOutcomes(T);
    expect(out).toHaveLength(1);
    expect(runner.calls[0]?.sql).toMatch(/FROM audit_outcomes/);
    expect(runner.calls[0]?.sql).toMatch(/ORDER BY recorded_at DESC/);
  });

  it('listAuditTrail() LEFT JOINs intents with outcomes', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          intent_id: INTENT_ID,
          tenant_id: T,
          run_id: null,
          step_no: 0,
          actor_type: 'agent',
          actor_id: null,
          action: 'a',
          resource_type: null,
          resource_id: null,
          tool_name: null,
          payload: null,
          payload_hash: null,
          intent_context_snapshot_hash: null,
          proposed_at: '2026-05-29T10:00:00.000Z',
          outcome_id: OUTCOME_ID,
          outcome_status: 'executed',
          outcome_result: null,
          outcome_result_hash: null,
          outcome_error_text: null,
          outcome_duration_ms: 50,
          outcome_cost_usd_micros: null,
          outcome_recorded_at: '2026-05-29T10:01:00.000Z',
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const trail = await store.listAuditTrail({ tenantId: T });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.intent.id).toBe(INTENT_ID);
    expect(trail[0]?.outcome?.id).toBe(OUTCOME_ID);
    expect(trail[0]?.outcome?.durationMs).toBe(50);
    expect(runner.calls[0]?.sql).toMatch(/LEFT JOIN audit_outcomes/);
    expect(runner.calls[0]?.sql).toMatch(/o\.tenant_id = i\.tenant_id/);
  });

  it('listAuditTrail() surfaces orphan intents with outcome=null', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        {
          intent_id: INTENT_ID,
          tenant_id: T,
          run_id: null,
          step_no: 0,
          actor_type: 'agent',
          actor_id: null,
          action: 'a',
          resource_type: null,
          resource_id: null,
          tool_name: null,
          payload: null,
          payload_hash: null,
          intent_context_snapshot_hash: null,
          proposed_at: '2026-05-29T10:00:00.000Z',
          outcome_id: null,
          outcome_status: null,
          outcome_result: null,
          outcome_result_hash: null,
          outcome_error_text: null,
          outcome_duration_ms: null,
          outcome_cost_usd_micros: null,
          outcome_recorded_at: null,
        },
      ],
    ];
    const store = new PostgresAuditStore(runner);
    const trail = await store.listAuditTrail({ tenantId: T });
    expect(trail).toHaveLength(1);
    expect(trail[0]?.outcome).toBeNull();
  });

  it('listAuditTrail() applies all optional filters when all are set', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresAuditStore(runner);
    await store.listAuditTrail({
      tenantId: T,
      resourceType: 'invoice',
      resourceId: 'inv-1',
      runId: 'run-1',
      limit: 50,
    });
    const sql = runner.calls[0]?.sql ?? '';
    expect(sql).toMatch(/i\.resource_type = \?/);
    expect(sql).toMatch(/i\.resource_id = \?/);
    expect(sql).toMatch(/i\.run_id = \?/);
    expect(sql).toMatch(/LIMIT \?/);
  });
});
