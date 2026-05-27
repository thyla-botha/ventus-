import { Hono } from 'hono';
import { z } from 'zod';
import {
  GatewayAuthError,
  scrub,
  verifyGatewayRequest,
  type CredentialStore,
} from '@ventus/credentials';
import { hashPayload } from '@ventus/audit';
import { isConnectorType, type ConnectorType } from '@ventus/credentials';
import type { AuditStore } from '@ventus/store';
import type { ForwarderRegistry } from './forwarder.js';

// Gateway app factory. Pure over its deps so tests can inject in-memory
// credential + audit stores and a deterministic forwarder. The binary
// entry (index.ts) wires the file-backed versions.
//
// Invariant chain enforced on every tool-call:
//   1. HMAC verify — fails closed on bad signature, stale ts, body tamper.
//   2. Parse request body — schema enforced via zod.
//   3. PII scrub the INPUT before any other handling. This is the
//      "pre-LLM redaction" promise, applied here because the gateway
//      response will be looped back into the agent's context.
//   4. Audit-INTENT row written BEFORE the connector call. If the
//      gateway crashes between intent and forward, the intent persists
//      and is visible to reconciliation.
//   5. Vault lookup — decrypts under the tenant's per-tenant subkey.
//      Missing credential is an outcome=failed row (NOT a no-row case;
//      we already wrote the intent).
//   6. Forwarder dispatch.
//   7. Audit-OUTCOME row written on settle (executed or failed). Best
//      effort — if the outcome write itself fails the intent is left as
//      an orphan, surfaced by the audit_trail reconciliation worker.

const ConnectorEnum = z.string().refine(isConnectorType, {
  message: 'unsupported connector type',
});

const ToolCallSchema = z
  .object({
    runId: z.string().uuid().optional(),
    stepNo: z.number().int().nonnegative().optional(),
    agentId: z.string().uuid().optional(),
    connector: ConnectorEnum,
    tool: z.string().min(1).max(128),
    input: z.unknown(),
  })
  .strict();

export interface GatewayDeps {
  credentials: CredentialStore;
  audit: AuditStore;
  forwarders: ForwarderRegistry;
  now?: () => number;
}

export function createGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'mcp-gateway', ts: new Date().toISOString() }),
  );

  app.post('/v1/tool-call', async (c) => {
    // --- 1. HMAC verify -----------------------------------------------------
    const rawBody = await c.req.text();
    let verified;
    try {
      verified = verifyGatewayRequest({
        method: 'POST',
        path: '/v1/tool-call',
        body: rawBody,
        headers: c.req.raw.headers,
        now: deps.now,
      });
    } catch (err) {
      if (err instanceof GatewayAuthError) {
        return c.json({ error: err.message }, err.status);
      }
      throw err;
    }

    // --- 2. Parse + validate body ------------------------------------------
    let parsedBody: unknown;
    try {
      parsedBody = rawBody.length === 0 ? {} : JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = ToolCallSchema.safeParse(parsedBody);
    if (!parsed.success) {
      return c.json({ error: 'invalid tool-call request', issues: parsed.error.issues }, 400);
    }
    const req = parsed.data;
    const connector = req.connector as ConnectorType;

    // --- 3. Scrub PII from input ------------------------------------------
    // The scrubbed value is what downstream connector code sees AND what
    // we persist in audit. The pre-scrub value never leaves this scope.
    const { value: scrubbedInput, report: scrubReport } = scrub(req.input);

    // --- 4. Audit intent BEFORE forward -----------------------------------
    const intent = await deps.audit.recordIntent({
      tenantId: verified.tenantId,
      runId: req.runId,
      stepNo: req.stepNo ?? 0,
      actorType: 'agent',
      actorId: req.agentId,
      action: `tool:${req.tool}`,
      toolName: req.tool,
      resourceType: 'connector',
      resourceId: connector,
      payload: scrubbedInput,
      payloadHash: hashPayload(scrubbedInput),
    });

    const startedAt = Date.now();

    // --- 5. Vault lookup ---------------------------------------------------
    const credential = await deps.credentials.get(verified.tenantId, connector);
    if (credential === null) {
      try {
        await deps.audit.recordOutcome({
          intentId: intent.id,
          tenantId: verified.tenantId,
          status: 'failed',
          errorText: `no credential for connector ${connector}`,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Orphan on outcome-write failure — reconciliation will surface.
      }
      return c.json({ error: 'no credential for connector' }, 412);
    }

    // --- 6. Dispatch to forwarder -----------------------------------------
    const forwarder = deps.forwarders.get(connector);
    if (!forwarder) {
      try {
        await deps.audit.recordOutcome({
          intentId: intent.id,
          tenantId: verified.tenantId,
          status: 'failed',
          errorText: `no forwarder registered for ${connector}`,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // see above
      }
      return c.json({ error: 'forwarder not registered' }, 501);
    }

    let forwarded;
    try {
      forwarded = await forwarder.forward({
        tenantId: verified.tenantId,
        connector,
        tool: req.tool,
        input: scrubbedInput,
        credential,
      });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      try {
        await deps.audit.recordOutcome({
          intentId: intent.id,
          tenantId: verified.tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // orphan
      }
      return c.json({ error: 'forwarder failed', message: errorText }, 502);
    }

    // --- 7. Audit outcome on settle ---------------------------------------
    try {
      await deps.audit.recordOutcome({
        intentId: intent.id,
        tenantId: verified.tenantId,
        status: 'executed',
        result: forwarded.data,
        resultHash: hashPayload(forwarded.data),
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // intent persisted; outcome missing → orphan in audit_trail.
    }

    return c.json({
      ok: true,
      intentId: intent.id,
      data: forwarded.data,
      scrub: scrubReport,
    });
  });

  return app;
}
