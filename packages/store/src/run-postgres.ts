import type {
  RunCompletion,
  RunInput,
  RunRecord,
  RunStatus,
  RunStore,
} from './types.js';
import {
  normalizeBigint,
  normalizeTimestamp,
  type PgFullRunner,
  type PgQuerier,
} from './postgres-types.js';

// Postgres-backed RunStore. Shape parity with FileRunStore — same method
// signatures, same null-vs-throw contracts. Where FileRunStore uses a
// per-instance writeLock to serialise RMW cycles, this implementation uses
// Postgres row locks (taken implicitly inside each UPDATE) + conditional
// WHERE clauses to collapse the lock dance into a single atomic statement.
//
// Tenant context handling:
//   - create(input): input carries tenantId → tenant-scoped INSERT under RLS.
//   - list({tenantId, ...}): tenant-scoped SELECT.
//   - list({status, ...}) with no tenantId: control-plane (reaper) usage.
//     Uses withAdmin to scan cross-tenant. This is the same RLS-bypass the
//     reaper documents needing post-Postgres swap.
//   - get(id) / complete(id) / requestCancel(id) / heartbeat(id) /
//     reapIfStale(id): by-id ops where the caller doesn't pass a tenant.
//     We do a single withAdmin lookup-then-write — RLS bypassed because
//     the id is a UUID with no enumeration risk and the WHERE clause
//     restricts the write to that exact row. The store layer is on the
//     audited RLS-bypass allowlist.
//
// Atomicity semantics:
//   - `complete` requires status='running' at the moment of UPDATE; otherwise
//     it throws. The conditional WHERE plus a follow-up SELECT distinguishes
//     "row missing" from "row terminal".
//   - `requestCancel` is idempotent: applies cancel fields only when the row
//     is currently 'running' AND not already cancel-requested. Returns the
//     row whether it was changed or not, null only when the row is missing.
//   - `heartbeat` no-ops on terminal rows. Returns the row even when no-op'd,
//     null only when missing — same contract as FileRunStore.
//   - `reapIfStale` is the file store's re-check-under-lock dance folded
//     into a single atomic UPDATE with WHERE status='running' AND
//     COALESCE(last_heartbeat_at, started_at) < staleAsOf. If a fresher
//     heartbeat lands between snapshot and write, the WHERE fails and we
//     return null — same "live loop survives" rule.

interface RunRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  skill_id: string | null;
  model: string | null;
  user_message: string | null;
  skill_content_hash: string | null;
  context_snapshot_hash: string | null;
  tenant_profile_hash: string | null;
  status: RunStatus;
  started_at: string | Date;
  ended_at: string | Date | null;
  total_cost_micros: number | string | null;
  proposal_count: number | null;
  final_text: string | null;
  halt_reason: string | null;
  error_text: string | null;
  cancel_requested_at: string | Date | null;
  cancel_requested_by: string | null;
  last_heartbeat_at: string | Date | null;
}

function rowToRecord(r: RunRow): RunRecord {
  const out: RunRecord = {
    id: r.id,
    tenantId: r.tenant_id,
    agentId: r.agent_id,
    status: r.status,
    startedAt: normalizeTimestamp(r.started_at),
  };
  if (r.skill_id !== null) out.skillId = r.skill_id;
  if (r.model !== null) out.model = r.model;
  if (r.user_message !== null) out.userMessage = r.user_message;
  if (r.skill_content_hash !== null) out.skillContentHash = r.skill_content_hash;
  if (r.context_snapshot_hash !== null) out.contextSnapshotHash = r.context_snapshot_hash;
  // tenant_profile_hash is tri-state in TS (undefined = caller doesn't
  // track, null = caller tracks but tenant has no profile). Postgres
  // collapses both to null; the application layer doesn't branch on the
  // distinction at read time, so the round-trip is safe.
  if (r.tenant_profile_hash !== null) out.tenantProfileHash = r.tenant_profile_hash;
  if (r.ended_at !== null) out.endedAt = normalizeTimestamp(r.ended_at);
  const totalCost = normalizeBigint(r.total_cost_micros);
  if (totalCost !== undefined) out.totalCostMicros = totalCost;
  if (r.proposal_count !== null) out.proposalCount = r.proposal_count;
  if (r.final_text !== null) out.finalText = r.final_text;
  if (r.halt_reason !== null) out.haltReason = r.halt_reason;
  if (r.error_text !== null) out.errorText = r.error_text;
  if (r.cancel_requested_at !== null) {
    out.cancelRequestedAt = normalizeTimestamp(r.cancel_requested_at);
  }
  if (r.cancel_requested_by !== null) out.cancelRequestedBy = r.cancel_requested_by;
  if (r.last_heartbeat_at !== null) {
    out.lastHeartbeatAt = normalizeTimestamp(r.last_heartbeat_at);
  }
  return out;
}

export class PostgresRunStore implements RunStore {
  constructor(private readonly runner: PgFullRunner) {}

  async create(input: RunInput): Promise<RunRecord> {
    const skillId = input.skillId ?? null;
    const model = input.model ?? null;
    const userMessage = input.userMessage ?? null;
    const skillContentHash = input.skillContentHash ?? null;
    const contextSnapshotHash = input.contextSnapshotHash ?? null;
    const tenantProfileHash = input.tenantProfileHash ?? null;
    const rows = await this.runner.withTenant({ tenantId: input.tenantId }, async (sql) => {
      return sql<RunRow>`
        INSERT INTO runs (
          tenant_id, agent_id, skill_id, model, user_message,
          skill_content_hash, context_snapshot_hash, tenant_profile_hash,
          status, started_at
        ) VALUES (
          ${input.tenantId}, ${input.agentId}, ${skillId}, ${model}, ${userMessage},
          ${skillContentHash}, ${contextSnapshotHash}, ${tenantProfileHash},
          'running', now()
        )
        RETURNING *
      `;
    });
    const row = rows[0];
    if (!row) throw new Error('PostgresRunStore.create: insert returned no row');
    return rowToRecord(row);
  }

  async get(id: string): Promise<RunRecord | null> {
    // Cross-tenant by-id read. The id is a UUID — no enumeration risk —
    // and the caller is expected to validate row.tenantId against the
    // request's tenant before exposing the row externally.
    const rows = await this.runner.withAdmin(async (sql) => {
      return sql<RunRow>`SELECT * FROM runs WHERE id = ${id} LIMIT 1`;
    });
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async list(filter?: {
    tenantId?: string;
    status?: RunStatus;
    agentId?: string;
    limit?: number;
  }): Promise<RunRecord[]> {
    const status = filter?.status;
    const agentId = filter?.agentId;
    const limit = filter?.limit ?? 1000;
    // Tenant-scoped path: RLS enforces isolation.
    if (filter?.tenantId !== undefined) {
      const tenantId = filter.tenantId;
      const rows = await this.runner.withTenant({ tenantId }, async (sql) =>
        listQuery(sql, { tenantId, status, agentId, limit }),
      );
      return rows.map(rowToRecord);
    }
    // Cross-tenant path: only used by the reaper, which legitimately needs
    // to scan all tenants. RLS bypassed.
    const rows = await this.runner.withAdmin(async (sql) =>
      listQuery(sql, { status, agentId, limit }),
    );
    return rows.map(rowToRecord);
  }

  async complete(id: string, completion: RunCompletion): Promise<RunRecord> {
    const totalCostMicros = completion.totalCostMicros ?? null;
    const proposalCount = completion.proposalCount ?? null;
    const finalText = completion.finalText ?? null;
    const haltReason = completion.haltReason ?? null;
    const errorText = completion.errorText ?? null;
    const status = completion.status;
    return this.runner.withAdmin(async (sql) => {
      const updated = await sql<RunRow>`
        UPDATE runs SET
          status              = ${status},
          ended_at            = now(),
          total_cost_micros   = ${totalCostMicros},
          proposal_count      = ${proposalCount},
          final_text          = ${finalText},
          halt_reason         = ${haltReason},
          error_text          = ${errorText}
        WHERE id = ${id}
          AND status = 'running'
        RETURNING *
      `;
      const row = updated[0];
      if (row) return rowToRecord(row);
      // 0 rows updated: distinguish "missing" from "not running".
      const existing = await sql<{ status: RunStatus }>`
        SELECT status FROM runs WHERE id = ${id} LIMIT 1
      `;
      if (existing.length === 0) throw new Error(`run not found: ${id}`);
      throw new Error(`run ${id} is not running (status=${existing[0]!.status})`);
    });
  }

  async requestCancel(
    id: string,
    by: { requestedBy: string; at?: string },
  ): Promise<RunRecord | null> {
    const at = by.at ?? new Date().toISOString();
    return this.runner.withAdmin(async (sql) => {
      // Conditional write: only stamp cancel_* when the row is still
      // running AND not already cancel-requested. Idempotent — non-running
      // or already-cancelled rows return their existing state.
      const rows = await sql<RunRow>`
        UPDATE runs SET
          cancel_requested_at = CASE
            WHEN status = 'running' AND cancel_requested_at IS NULL THEN ${at}::timestamptz
            ELSE cancel_requested_at
          END,
          cancel_requested_by = CASE
            WHEN status = 'running' AND cancel_requested_at IS NULL THEN ${by.requestedBy}
            ELSE cancel_requested_by
          END
        WHERE id = ${id}
        RETURNING *
      `;
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async heartbeat(id: string, at?: string): Promise<RunRecord | null> {
    const stamp = at ?? new Date().toISOString();
    return this.runner.withAdmin(async (sql) => {
      // No-op on terminal rows: the agent loop may race the reaper, and a
      // write-after-close should NOT throw. Single conditional UPDATE — SET
      // only fires for running rows; non-running rows return unchanged.
      const rows = await sql<RunRow>`
        UPDATE runs SET
          last_heartbeat_at = CASE
            WHEN status = 'running' THEN ${stamp}::timestamptz
            ELSE last_heartbeat_at
          END
        WHERE id = ${id}
        RETURNING *
      `;
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async reapIfStale(
    id: string,
    opts: { staleAsOf: string; completion: RunCompletion },
  ): Promise<RunRecord | null> {
    // Defensive: a NaN watermark would silently authorise every reap. The
    // file store throws here; we do too for shape parity.
    const staleAsOfMs = new Date(opts.staleAsOf).getTime();
    if (!Number.isFinite(staleAsOfMs)) {
      throw new Error(`reapIfStale: malformed staleAsOf=${opts.staleAsOf}`);
    }
    const c = opts.completion;
    const totalCostMicros = c.totalCostMicros ?? null;
    const proposalCount = c.proposalCount ?? null;
    const finalText = c.finalText ?? null;
    const haltReason = c.haltReason ?? null;
    const errorText = c.errorText ?? null;
    return this.runner.withAdmin(async (sql) => {
      // Atomic single-statement reap. The WHERE encodes:
      //   - row still 'running'
      //   - COALESCE(last_heartbeat_at, started_at) < staleAsOf
      // so a heartbeat that landed between the reaper's snapshot and now
      // pushes the row out of the WHERE; the UPDATE returns 0 rows, which
      // maps to null — the live loop survives.
      const rows = await sql<RunRow>`
        UPDATE runs SET
          status            = ${c.status},
          ended_at          = now(),
          total_cost_micros = ${totalCostMicros},
          proposal_count    = ${proposalCount},
          final_text        = ${finalText},
          halt_reason       = ${haltReason},
          error_text        = ${errorText}
        WHERE id = ${id}
          AND status = 'running'
          AND COALESCE(last_heartbeat_at, started_at) < ${opts.staleAsOf}::timestamptz
        RETURNING *
      `;
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }
}

// Extracted because list() has two paths (tenant-scoped + cross-tenant)
// that share the same filter logic and need the same query shapes.
async function listQuery(
  sql: PgQuerier,
  f: {
    tenantId?: string;
    status?: RunStatus;
    agentId?: string;
    limit: number;
  },
): Promise<RunRow[]> {
  const { tenantId, status, agentId, limit } = f;
  if (tenantId !== undefined && status !== undefined && agentId !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE tenant_id = ${tenantId} AND status = ${status} AND agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (tenantId !== undefined && status !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE tenant_id = ${tenantId} AND status = ${status}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (tenantId !== undefined && agentId !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE tenant_id = ${tenantId} AND agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (tenantId !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (status !== undefined && agentId !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE status = ${status} AND agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (status !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE status = ${status}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  if (agentId !== undefined) {
    return sql<RunRow>`
      SELECT * FROM runs
      WHERE agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
  }
  return sql<RunRow>`
    SELECT * FROM runs
    ORDER BY started_at DESC LIMIT ${limit}
  `;
}
