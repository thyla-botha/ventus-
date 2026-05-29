import type {
  AuditIntentRecord,
  AuditOutcomeRecord,
  AuditStore,
  AuditTrailFilter,
  AuditTrailRow,
} from './types.js';
import { AuditOutcomeReferentialError } from './audit-file.js';
import {
  normalizeBigint,
  normalizeTimestamp,
  type PgQuerier,
  type PgTenantRunner,
} from './postgres-types.js';

// Postgres-backed AuditStore. Same contracts as FileAuditStore:
//   - recordIntent: INSERT returning the row
//   - recordOutcome: INSERT that MUST reference an intent owned by the same
//     tenant. Migration 0008 adds a composite FK (intent_id, tenant_id) →
//     audit_intents(id, tenant_id) so a cross-tenant outcome surfaces as a
//     foreign_key_violation, which we translate to AuditOutcomeReferentialError
//     for shape parity with the file store. Without that composite FK,
//     Postgres' single-column FK bypasses RLS and the cross-tenant write
//     would succeed silently.
//   - listIntents / listOutcomes / listAuditTrail: tenant-scoped reads.

interface IntentRow {
  id: string;
  tenant_id: string;
  run_id: string | null;
  step_no: number;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  tool_name: string | null;
  payload: unknown;
  payload_hash: string | null;
  context_snapshot_hash: string | null;
  proposed_at: string | Date;
}

interface OutcomeRow {
  id: string;
  intent_id: string;
  tenant_id: string;
  status: AuditOutcomeRecord['status'];
  result: unknown;
  result_hash: string | null;
  error_text: string | null;
  duration_ms: number | null;
  cost_usd_micros: number | string | null;
  recorded_at: string | Date;
}

function intentRowToRecord(r: IntentRow): AuditIntentRecord {
  const out: AuditIntentRecord = {
    id: r.id,
    tenantId: r.tenant_id,
    stepNo: r.step_no,
    actorType: r.actor_type,
    action: r.action,
    proposedAt: normalizeTimestamp(r.proposed_at),
  };
  if (r.run_id !== null) out.runId = r.run_id;
  if (r.actor_id !== null) out.actorId = r.actor_id;
  if (r.resource_type !== null) out.resourceType = r.resource_type;
  if (r.resource_id !== null) out.resourceId = r.resource_id;
  if (r.tool_name !== null) out.toolName = r.tool_name;
  if (r.payload !== null && r.payload !== undefined) out.payload = r.payload;
  if (r.payload_hash !== null) out.payloadHash = r.payload_hash;
  if (r.context_snapshot_hash !== null) out.contextSnapshotHash = r.context_snapshot_hash;
  return out;
}

function outcomeRowToRecord(r: OutcomeRow): AuditOutcomeRecord {
  const out: AuditOutcomeRecord = {
    id: r.id,
    intentId: r.intent_id,
    tenantId: r.tenant_id,
    status: r.status,
    recordedAt: normalizeTimestamp(r.recorded_at),
  };
  if (r.result !== null && r.result !== undefined) out.result = r.result;
  if (r.result_hash !== null) out.resultHash = r.result_hash;
  if (r.error_text !== null) out.errorText = r.error_text;
  if (r.duration_ms !== null) out.durationMs = r.duration_ms;
  const cost = normalizeBigint(r.cost_usd_micros);
  if (cost !== undefined) out.costUsdMicros = cost;
  return out;
}

// Postgres error shape varies by driver. postgres.js raises a PostgresError
// whose `code` field is the SQLSTATE — 23503 for foreign_key_violation.
function isForeignKeyViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23503';
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly runner: PgTenantRunner) {}

  async recordIntent(
    input: Omit<AuditIntentRecord, 'id' | 'proposedAt'>,
  ): Promise<AuditIntentRecord> {
    const runId = input.runId ?? null;
    const actorId = input.actorId ?? null;
    const resourceType = input.resourceType ?? null;
    const resourceId = input.resourceId ?? null;
    const toolName = input.toolName ?? null;
    const payload = input.payload === undefined ? null : input.payload;
    const payloadHash = input.payloadHash ?? null;
    const contextSnapshotHash = input.contextSnapshotHash ?? null;
    // payload stringification: postgres.js handles jsonb via parameterized
    // sql with the value passed through. We rely on the driver to serialize
    // the JSON value rather than stringifying ourselves.
    const rows = await this.runner.withTenant(
      { tenantId: input.tenantId },
      async (sql) => sql<IntentRow>`
        INSERT INTO audit_intents (
          tenant_id, run_id, step_no, actor_type, actor_id,
          action, resource_type, resource_id, tool_name,
          payload, payload_hash, context_snapshot_hash, proposed_at
        ) VALUES (
          ${input.tenantId}, ${runId}, ${input.stepNo}, ${input.actorType}, ${actorId},
          ${input.action}, ${resourceType}, ${resourceId}, ${toolName},
          ${payload as never}, ${payloadHash}, ${contextSnapshotHash}, now()
        )
        RETURNING *
      `,
    );
    const row = rows[0];
    if (!row) throw new Error('PostgresAuditStore.recordIntent: insert returned no row');
    return intentRowToRecord(row);
  }

  async recordOutcome(
    input: Omit<AuditOutcomeRecord, 'id' | 'recordedAt'>,
  ): Promise<AuditOutcomeRecord> {
    const result = input.result === undefined ? null : input.result;
    const resultHash = input.resultHash ?? null;
    const errorText = input.errorText ?? null;
    const durationMs = input.durationMs ?? null;
    const costUsdMicros = input.costUsdMicros ?? null;
    try {
      const rows = await this.runner.withTenant(
        { tenantId: input.tenantId },
        async (sql) => sql<OutcomeRow>`
          INSERT INTO audit_outcomes (
            intent_id, tenant_id, status, result, result_hash,
            error_text, duration_ms, cost_usd_micros, recorded_at
          ) VALUES (
            ${input.intentId}, ${input.tenantId}, ${input.status}, ${result as never}, ${resultHash},
            ${errorText}, ${durationMs}, ${costUsdMicros}, now()
          )
          RETURNING *
        `,
      );
      const row = rows[0];
      if (!row) throw new Error('PostgresAuditStore.recordOutcome: insert returned no row');
      return outcomeRowToRecord(row);
    } catch (err) {
      // Composite FK violation: either the intent doesn't exist OR it
      // belongs to a different tenant. Either is a referential error in
      // the file-store sense.
      if (isForeignKeyViolation(err)) {
        throw new AuditOutcomeReferentialError(input.intentId, input.tenantId);
      }
      throw err;
    }
  }

  async listIntents(tenantId: string): Promise<AuditIntentRecord[]> {
    const rows = await this.runner.withTenant({ tenantId }, async (sql) =>
      sql<IntentRow>`
        SELECT * FROM audit_intents
        WHERE tenant_id = ${tenantId}
        ORDER BY proposed_at DESC
      `,
    );
    return rows.map(intentRowToRecord);
  }

  async listOutcomes(tenantId: string): Promise<AuditOutcomeRecord[]> {
    const rows = await this.runner.withTenant({ tenantId }, async (sql) =>
      sql<OutcomeRow>`
        SELECT * FROM audit_outcomes
        WHERE tenant_id = ${tenantId}
        ORDER BY recorded_at DESC
      `,
    );
    return rows.map(outcomeRowToRecord);
  }

  async listAuditTrail(filter: AuditTrailFilter): Promise<AuditTrailRow[]> {
    const tenantId = filter.tenantId;
    const limit = filter.limit ?? 1000;
    // LEFT JOIN intents → outcomes so orphaned intents surface with
    // outcome=null. Mirrors FileAuditStore.listAuditTrail behaviour.
    // Manual filter clauses because postgres.js tagged-template inlining
    // can't optionally include WHERE fragments.
    const rows = await this.runner.withTenant({ tenantId }, async (sql) =>
      trailQuery(sql, tenantId, filter, limit),
    );
    return rows.map((r) => {
      const intent = intentRowToRecord({
        id: r.intent_id,
        tenant_id: r.tenant_id,
        run_id: r.run_id,
        step_no: r.step_no,
        actor_type: r.actor_type,
        actor_id: r.actor_id,
        action: r.action,
        resource_type: r.resource_type,
        resource_id: r.resource_id,
        tool_name: r.tool_name,
        payload: r.payload,
        payload_hash: r.payload_hash,
        context_snapshot_hash: r.intent_context_snapshot_hash,
        proposed_at: r.proposed_at,
      });
      const outcome: AuditOutcomeRecord | null = r.outcome_id
        ? outcomeRowToRecord({
            id: r.outcome_id,
            intent_id: r.intent_id,
            tenant_id: r.tenant_id,
            status: r.outcome_status!,
            result: r.outcome_result,
            result_hash: r.outcome_result_hash,
            error_text: r.outcome_error_text,
            duration_ms: r.outcome_duration_ms,
            cost_usd_micros: r.outcome_cost_usd_micros,
            recorded_at: r.outcome_recorded_at!,
          })
        : null;
      return { intent, outcome };
    });
  }
}

interface TrailJoinRow {
  intent_id: string;
  tenant_id: string;
  run_id: string | null;
  step_no: number;
  actor_type: 'user' | 'agent' | 'system';
  actor_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  tool_name: string | null;
  payload: unknown;
  payload_hash: string | null;
  intent_context_snapshot_hash: string | null;
  proposed_at: string | Date;
  outcome_id: string | null;
  outcome_status: AuditOutcomeRecord['status'] | null;
  outcome_result: unknown;
  outcome_result_hash: string | null;
  outcome_error_text: string | null;
  outcome_duration_ms: number | null;
  outcome_cost_usd_micros: number | string | null;
  outcome_recorded_at: string | Date | null;
}

async function trailQuery(
  sql: PgQuerier,
  tenantId: string,
  f: AuditTrailFilter,
  limit: number,
): Promise<TrailJoinRow[]> {
  // We branch on the optional filters explicitly. The repeated SELECT list
  // is a price worth paying for parameterized clarity — composing WHERE
  // fragments dynamically in tagged-template SQL is where injection bugs
  // creep in.
  const select = (() => {
    if (f.resourceType !== undefined && f.resourceId !== undefined && f.runId !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.resource_type = ${f.resourceType}
          AND i.resource_id = ${f.resourceId}
          AND i.run_id = ${f.runId}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    if (f.resourceType !== undefined && f.resourceId !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.resource_type = ${f.resourceType}
          AND i.resource_id = ${f.resourceId}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    if (f.resourceType !== undefined && f.runId !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.resource_type = ${f.resourceType}
          AND i.run_id = ${f.runId}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    if (f.resourceType !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.resource_type = ${f.resourceType}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    if (f.runId !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.run_id = ${f.runId}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    if (f.resourceId !== undefined) {
      return sql<TrailJoinRow>`
        SELECT
          i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
          i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
          i.payload, i.payload_hash,
          i.context_snapshot_hash AS intent_context_snapshot_hash,
          i.proposed_at,
          o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
          o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
          o.duration_ms AS outcome_duration_ms,
          o.cost_usd_micros AS outcome_cost_usd_micros,
          o.recorded_at AS outcome_recorded_at
        FROM audit_intents i
        LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
        WHERE i.tenant_id = ${tenantId}
          AND i.resource_id = ${f.resourceId}
        ORDER BY i.proposed_at DESC
        LIMIT ${limit}
      `;
    }
    return sql<TrailJoinRow>`
      SELECT
        i.id AS intent_id, i.tenant_id, i.run_id, i.step_no, i.actor_type,
        i.actor_id, i.action, i.resource_type, i.resource_id, i.tool_name,
        i.payload, i.payload_hash,
        i.context_snapshot_hash AS intent_context_snapshot_hash,
        i.proposed_at,
        o.id AS outcome_id, o.status AS outcome_status, o.result AS outcome_result,
        o.result_hash AS outcome_result_hash, o.error_text AS outcome_error_text,
        o.duration_ms AS outcome_duration_ms,
        o.cost_usd_micros AS outcome_cost_usd_micros,
        o.recorded_at AS outcome_recorded_at
      FROM audit_intents i
      LEFT JOIN audit_outcomes o ON o.intent_id = i.id AND o.tenant_id = i.tenant_id
      WHERE i.tenant_id = ${tenantId}
      ORDER BY i.proposed_at DESC
      LIMIT ${limit}
    `;
  })();
  return select;
}
