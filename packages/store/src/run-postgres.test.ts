import { describe, expect, it } from 'vitest';
import { PostgresRunStore } from './run-postgres.js';
import type { PgFullRunner, PgQuerier } from './postgres-types.js';

// Tests use stub runners that capture SQL templates joined with '?'
// placeholders so we can assert statement shape AND runtime behaviour.
// An integration test against a real DB lives elsewhere (gated by
// DATABASE_URL_TEST).

interface CapturedCall {
  sql: string;
  values: unknown[];
  scope: 'tenant' | 'admin';
  tenantId?: string;
}

interface ScriptedRow {
  // Either a static row set or a function that picks the rows by SQL shape.
  match?: (sql: string) => boolean;
  rows: unknown[] | ((sql: string, values: unknown[]) => unknown[]);
}

class StubRunner implements PgFullRunner {
  calls: CapturedCall[] = [];
  txCount = 0;
  adminCount = 0;
  // Per-call scripted responses, consumed in order.
  responses: Array<unknown[] | ((sql: string, values: unknown[]) => unknown[])> = [];

  async withTenant<T>(
    ctx: { tenantId: string; userId?: string },
    fn: (sql: PgQuerier) => Promise<T>,
  ): Promise<T> {
    this.txCount++;
    return fn(this.makeQuerier('tenant', ctx.tenantId));
  }

  async withAdmin<T>(fn: (sql: PgQuerier) => Promise<T>): Promise<T> {
    this.adminCount++;
    return fn(this.makeQuerier('admin'));
  }

  private makeQuerier(scope: 'tenant' | 'admin', tenantId?: string): PgQuerier {
    return (async <U = unknown>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<U[]> => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      const call: CapturedCall = { sql, values, scope };
      if (tenantId !== undefined) call.tenantId = tenantId;
      this.calls.push(call);
      const next = this.responses.shift();
      if (next === undefined) throw new Error(`StubRunner: no response for: ${sql.slice(0, 80)}`);
      const rows = typeof next === 'function' ? next(sql, values) : next;
      return rows as U[];
    }) as PgQuerier;
  }
}

const T = '11111111-1111-1111-1111-111111111111';
const R = '22222222-2222-2222-2222-222222222222';

function fakeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: R,
    tenant_id: T,
    agent_id: 'agent-x',
    skill_id: null,
    model: null,
    user_message: null,
    skill_content_hash: null,
    context_snapshot_hash: null,
    tenant_profile_hash: null,
    status: 'running',
    started_at: '2026-05-29T10:00:00.000Z',
    ended_at: null,
    total_cost_micros: null,
    proposal_count: null,
    final_text: null,
    halt_reason: null,
    error_text: null,
    cancel_requested_at: null,
    cancel_requested_by: null,
    last_heartbeat_at: null,
    ...overrides,
  };
}

describe('PostgresRunStore', () => {
  it('create() inserts under tenant context and returns the row', async () => {
    const runner = new StubRunner();
    runner.responses = [[fakeRow()]];
    const store = new PostgresRunStore(runner);
    const row = await store.create({ tenantId: T, agentId: 'agent-x' });
    expect(row).toEqual({
      id: R,
      tenantId: T,
      agentId: 'agent-x',
      status: 'running',
      startedAt: '2026-05-29T10:00:00.000Z',
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.scope).toBe('tenant');
    expect(runner.calls[0]?.tenantId).toBe(T);
    expect(runner.calls[0]?.sql).toMatch(/INSERT INTO runs/);
    expect(runner.calls[0]?.sql).toMatch(/'running'/);
  });

  it('create() forwards provenance fields, leaving null for absent ones', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [
        fakeRow({
          skill_id: 'sk-1',
          model: 'claude-3-5',
          user_message: 'hi',
          skill_content_hash: 'h1',
          context_snapshot_hash: 'h2',
          tenant_profile_hash: 'h3',
        }),
      ],
    ];
    const store = new PostgresRunStore(runner);
    const row = await store.create({
      tenantId: T,
      agentId: 'agent-x',
      skillId: 'sk-1',
      model: 'claude-3-5',
      userMessage: 'hi',
      skillContentHash: 'h1',
      contextSnapshotHash: 'h2',
      tenantProfileHash: 'h3',
    });
    expect(row.skillId).toBe('sk-1');
    expect(row.model).toBe('claude-3-5');
    expect(row.userMessage).toBe('hi');
    expect(row.skillContentHash).toBe('h1');
    expect(row.contextSnapshotHash).toBe('h2');
    expect(row.tenantProfileHash).toBe('h3');
    const values = runner.calls[0]?.values ?? [];
    expect(values).toContain('sk-1');
    expect(values).toContain('claude-3-5');
  });

  it('get() reads via admin and returns null for missing rows', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresRunStore(runner);
    const row = await store.get(R);
    expect(row).toBeNull();
    expect(runner.calls[0]?.scope).toBe('admin');
    expect(runner.calls[0]?.sql).toMatch(/SELECT \* FROM runs/);
    expect(runner.calls[0]?.sql).toMatch(/WHERE id = \?/);
  });

  it('get() returns mapped record when row exists', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [fakeRow({ status: 'completed', ended_at: '2026-05-29T11:00:00.000Z', total_cost_micros: '12345' })],
    ];
    const store = new PostgresRunStore(runner);
    const row = await store.get(R);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('completed');
    expect(row!.endedAt).toBe('2026-05-29T11:00:00.000Z');
    expect(row!.totalCostMicros).toBe(12345);
  });

  it('list({tenantId}) uses tenant scope', async () => {
    const runner = new StubRunner();
    runner.responses = [[fakeRow()]];
    const store = new PostgresRunStore(runner);
    const out = await store.list({ tenantId: T });
    expect(out).toHaveLength(1);
    expect(runner.calls[0]?.scope).toBe('tenant');
    expect(runner.calls[0]?.tenantId).toBe(T);
    expect(runner.calls[0]?.sql).toMatch(/WHERE tenant_id = \?/);
    expect(runner.calls[0]?.sql).toMatch(/ORDER BY started_at DESC/);
  });

  it('list({status}) without tenant uses admin scope (reaper path)', async () => {
    const runner = new StubRunner();
    runner.responses = [[fakeRow()]];
    const store = new PostgresRunStore(runner);
    const out = await store.list({ status: 'running' });
    expect(out).toHaveLength(1);
    expect(runner.calls[0]?.scope).toBe('admin');
    expect(runner.calls[0]?.sql).toMatch(/WHERE status = \?/);
  });

  it('list({tenantId, status, agentId}) combines all filters under tenant scope', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresRunStore(runner);
    await store.list({ tenantId: T, status: 'running', agentId: 'agent-x' });
    expect(runner.calls[0]?.sql).toMatch(/WHERE tenant_id = \? AND status = \? AND agent_id = \?/);
  });

  it('complete() updates only running rows and returns mapped record', async () => {
    const runner = new StubRunner();
    runner.responses = [[fakeRow({ status: 'completed', ended_at: '2026-05-29T11:00:00.000Z' })]];
    const store = new PostgresRunStore(runner);
    const row = await store.complete(R, { status: 'completed', finalText: 'ok' });
    expect(row.status).toBe('completed');
    expect(runner.calls[0]?.scope).toBe('admin');
    expect(runner.calls[0]?.sql).toMatch(/UPDATE runs SET/);
    expect(runner.calls[0]?.sql).toMatch(/WHERE id = \? AND status = 'running'/);
  });

  it('complete() throws "run not found" when no row matches the id', async () => {
    const runner = new StubRunner();
    // First call (UPDATE) returns 0 rows. Second call (SELECT) returns 0 rows → not found.
    runner.responses = [[], []];
    const store = new PostgresRunStore(runner);
    await expect(store.complete(R, { status: 'completed' })).rejects.toThrow(/run not found/);
  });

  it('complete() throws "not running" when row exists but is terminal', async () => {
    const runner = new StubRunner();
    runner.responses = [[], [{ status: 'completed' }]];
    const store = new PostgresRunStore(runner);
    await expect(store.complete(R, { status: 'completed' })).rejects.toThrow(
      /not running.*status=completed/,
    );
  });

  it('requestCancel() is idempotent — returns the row even when already cancelled', async () => {
    const runner = new StubRunner();
    // Returns the row in both call shapes.
    runner.responses = [
      [
        fakeRow({
          cancel_requested_at: '2026-05-29T10:30:00.000Z',
          cancel_requested_by: 'user-1',
        }),
      ],
    ];
    const store = new PostgresRunStore(runner);
    const row = await store.requestCancel(R, { requestedBy: 'user-2' });
    expect(row).not.toBeNull();
    expect(row!.cancelRequestedAt).toBe('2026-05-29T10:30:00.000Z');
    expect(row!.cancelRequestedBy).toBe('user-1');
    expect(runner.calls[0]?.sql).toMatch(/cancel_requested_at IS NULL/);
  });

  it('requestCancel() returns null for missing row', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresRunStore(runner);
    const row = await store.requestCancel(R, { requestedBy: 'user-2' });
    expect(row).toBeNull();
  });

  it('heartbeat() returns existing row (no-op) when row is terminal', async () => {
    const runner = new StubRunner();
    runner.responses = [[fakeRow({ status: 'completed' })]];
    const store = new PostgresRunStore(runner);
    const row = await store.heartbeat(R);
    expect(row?.status).toBe('completed');
    expect(runner.calls[0]?.sql).toMatch(/CASE WHEN status = 'running'/);
  });

  it('heartbeat() returns null for missing row', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresRunStore(runner);
    const row = await store.heartbeat(R);
    expect(row).toBeNull();
  });

  it('reapIfStale() throws on NaN watermark', async () => {
    const runner = new StubRunner();
    const store = new PostgresRunStore(runner);
    await expect(
      store.reapIfStale(R, {
        staleAsOf: 'not-a-date',
        completion: { status: 'failed' },
      }),
    ).rejects.toThrow(/malformed staleAsOf/);
    expect(runner.calls).toHaveLength(0);
  });

  it('reapIfStale() returns null when the WHERE filters the row out (fresh heartbeat)', async () => {
    const runner = new StubRunner();
    runner.responses = [[]];
    const store = new PostgresRunStore(runner);
    const out = await store.reapIfStale(R, {
      staleAsOf: '2026-05-29T10:00:00.000Z',
      completion: { status: 'failed', errorText: 'no heartbeat' },
    });
    expect(out).toBeNull();
    expect(runner.calls[0]?.sql).toMatch(
      /WHERE id = \? AND status = 'running' AND COALESCE\(last_heartbeat_at, started_at\) </,
    );
  });

  it('reapIfStale() returns the closed row when reaped', async () => {
    const runner = new StubRunner();
    runner.responses = [
      [fakeRow({ status: 'failed', ended_at: '2026-05-29T11:00:00.000Z', error_text: 'no heartbeat' })],
    ];
    const store = new PostgresRunStore(runner);
    const out = await store.reapIfStale(R, {
      staleAsOf: '2026-05-29T10:00:00.000Z',
      completion: { status: 'failed', errorText: 'no heartbeat' },
    });
    expect(out?.status).toBe('failed');
    expect(out?.errorText).toBe('no heartbeat');
  });
});
