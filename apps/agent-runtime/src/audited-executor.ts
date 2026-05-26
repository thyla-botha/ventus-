import { hashPayload } from '@ventus/audit';
import type { AuditStore } from '@ventus/store';
import type { ToolExecutor } from './runtime.js';

// Composes a base ToolExecutor with the two-phase audit pattern.
//   1. Record an intent row BEFORE the call (action=tool:<name>, payload=input).
//   2. Call the base executor.
//   3. Record an outcome row AFTER (status=executed | failed, result or error).
//
// If the outcome write itself fails, the intent persists as "orphaned" — the
// audit_trail view (or the file-backed equivalent here) lists those for
// reconciliation. This is the platform safety primitive every tier-2+ Skill
// depends on; do not short-circuit it.

interface AuditWrapOptions {
  audit: AuditStore;
  tenantId: string;
  runId: string;
  agentId: string;
  // Optional — when set, every intent recorded by this executor carries the
  // originating run's context snapshot hash. Lets the audit_trail join
  // back to the exact prompt + tool list that produced the tool call.
  contextSnapshotHash?: string;
}

export function auditedExecutor(
  base: ToolExecutor,
  opts: AuditWrapOptions,
): ToolExecutor {
  return async (name, input, ctx) => {
    const startedAt = Date.now();
    const intent = await opts.audit.recordIntent({
      tenantId: opts.tenantId,
      runId: opts.runId,
      stepNo: ctx.stepNo,
      actorType: 'agent',
      actorId: opts.agentId,
      action: `tool:${name}`,
      toolName: name,
      payload: input,
      payloadHash: hashPayload(input),
      contextSnapshotHash: opts.contextSnapshotHash,
    });

    // Inner try wraps ONLY the base tool call. After it returns successfully,
    // the side effect is committed; a downstream audit-write failure must not
    // be rewritten as a "failed" outcome — leave the intent as an orphan.
    let result: unknown;
    try {
      result = await base(name, input, ctx);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await opts.audit.recordOutcome({
          intentId: intent.id,
          tenantId: opts.tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // outcome write failed — intent remains as orphan in audit trail
      }
      throw err;
    }

    try {
      await opts.audit.recordOutcome({
        intentId: intent.id,
        tenantId: opts.tenantId,
        status: 'executed',
        result,
        resultHash: hashPayload(result),
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // intent persisted; outcome missing → orphan in audit_trail.
    }
    return result;
  };
}
