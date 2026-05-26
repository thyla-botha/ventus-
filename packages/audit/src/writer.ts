import type { TenantClient, TenantContext } from '@ventus/db';
import { withTenant } from '@ventus/db';
import type { AuditActorType, AuditOutcomeStatus } from '@ventus/db/types';
import { hashPayload } from './hash.js';

export interface IntentInput {
  runId?: string;
  stepNo?: number;
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  toolName?: string;
  payload?: unknown;
  ipAddress?: string;
  userAgent?: string;
}

export interface OutcomeInput {
  intentId: string;
  status: AuditOutcomeStatus;
  result?: unknown;
  errorText?: string;
  durationMs?: number;
  costUsdMicros?: number;
}

// JSONB columns are written as serialized text with an explicit ::jsonb cast.
// Avoids the postgres-js parameter-type mismatch on `unknown` payloads while
// preserving full fidelity. Null is preserved as SQL NULL.
function jsonbParam(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return JSON.stringify(v);
}

export async function recordIntent(
  ctx: TenantContext,
  input: IntentInput,
  sql?: TenantClient,
): Promise<{ id: string }> {
  const payloadHash = input.payload === undefined ? null : hashPayload(input.payload);
  const insert = async (s: TenantClient): Promise<{ id: string }> => {
    const rows = (await s`
      INSERT INTO audit_intents (
        tenant_id, run_id, step_no, actor_type, actor_id, action,
        resource_type, resource_id, tool_name, payload, payload_hash,
        ip_address, user_agent
      ) VALUES (
        ${ctx.tenantId}, ${input.runId ?? null}, ${input.stepNo ?? 0},
        ${input.actorType}, ${input.actorId ?? null}, ${input.action},
        ${input.resourceType ?? null}, ${input.resourceId ?? null},
        ${input.toolName ?? null}, ${jsonbParam(input.payload)}::jsonb, ${payloadHash},
        ${input.ipAddress ?? null}, ${input.userAgent ?? null}
      )
      RETURNING id
    `) as unknown as Array<{ id: string }>;
    if (!rows[0]) throw new Error('audit intent insert returned no row');
    return rows[0];
  };
  return sql ? insert(sql) : withTenant(ctx, insert);
}

export async function recordOutcome(
  ctx: TenantContext,
  input: OutcomeInput,
  sql?: TenantClient,
): Promise<void> {
  const resultHash = input.result === undefined ? null : hashPayload(input.result);
  const insert = async (s: TenantClient): Promise<void> => {
    await s`
      INSERT INTO audit_outcomes (
        intent_id, tenant_id, status, result, result_hash,
        error_text, duration_ms, cost_usd_micros
      ) VALUES (
        ${input.intentId}, ${ctx.tenantId}, ${input.status},
        ${jsonbParam(input.result)}::jsonb, ${resultHash},
        ${input.errorText ?? null}, ${input.durationMs ?? null},
        ${input.costUsdMicros ?? null}
      )
    `;
  };
  if (sql) await insert(sql);
  else await withTenant(ctx, insert);
}

// withAudit() wraps an action in the two-phase pattern.
// Intent is recorded first; outcome is recorded after the action settles.
// If the action throws, an outcome with status='failed' is written before re-throwing.
// If the outcome write itself fails, the intent remains as an "orphaned" row in audit_trail.
export async function withAudit<T>(
  ctx: TenantContext,
  intent: IntentInput,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const { id: intentId } = await recordIntent(ctx, intent);
  try {
    const result = await action();
    await recordOutcome(ctx, {
      intentId,
      status: 'executed',
      result,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    try {
      await recordOutcome(ctx, {
        intentId,
        status: 'failed',
        errorText,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // Outcome write failed. The intent remains as orphaned in audit_trail;
      // reconciliation worker is responsible for surfacing these.
    }
    throw err;
  }
}
