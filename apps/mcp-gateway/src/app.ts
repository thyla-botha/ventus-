import { Hono } from 'hono';
import { z } from 'zod';
import {
  GatewayAuthError,
  InMemoryNonceStore,
  scrub,
  verifyGatewayRequest,
  type CredentialStore,
  type NonceStore,
  type ScrubReport,
} from '@ventus/credentials';
import { hashPayload } from '@ventus/audit';
import { isConnectorType, type ConnectorType } from '@ventus/credentials';
import type { AuditStore } from '@ventus/store';
import type { ForwarderRegistry } from './forwarder.js';

// Combine two scrub reports for the response. Used when both the input
// (pre-forward) and output (post-forward) get scrubbed — the agent sees
// a single counts/redacted summary rather than two.
function mergeScrubReports(a: ScrubReport, b: ScrubReport): ScrubReport {
  const counts: ScrubReport['counts'] = { ...a.counts };
  for (const [k, v] of Object.entries(b.counts)) {
    if (v === undefined) continue;
    counts[k as keyof ScrubReport['counts']] =
      (counts[k as keyof ScrubReport['counts']] ?? 0) + v;
  }
  return { counts, redacted: a.redacted || b.redacted };
}

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
  // CODEX HIGH-3: replay-protection store for HMAC nonces. Defaults to
  // an in-process Map for single-replica deployments; swap for a Redis-
  // or DB-backed store when running multiple gateway replicas.
  nonceStore?: NonceStore;
  now?: () => number;
}

export function createGatewayApp(deps: GatewayDeps): Hono {
  const app = new Hono();
  const nonceStore = deps.nonceStore ?? new InMemoryNonceStore();

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
        nonceStore,
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
      // CODEX HIGH-6: forwarder exception text may contain URLs, request
      // headers, OAuth tokens, or other tenant data. Log the full text
      // server-side for forensics; store a scrubbed copy in audit so the
      // PII rules apply to errors too; return a generic message to the
      // caller so the agent's tool-result block never carries raw bytes
      // back into the next LLM prompt.
      const rawErrorText = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[mcp-gateway] forwarder threw:', rawErrorText);
      const { value: scrubbedError } = scrub(rawErrorText);
      const auditedErrorText =
        typeof scrubbedError === 'string' ? scrubbedError : rawErrorText;
      try {
        await deps.audit.recordOutcome({
          intentId: intent.id,
          tenantId: verified.tenantId,
          status: 'failed',
          errorText: auditedErrorText,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // orphan; failure path is already user-visible as 502
      }
      return c.json({ error: 'forwarder failed' }, 502);
    }

    // --- 7. Scrub connector OUTPUT before audit + response ---------------
    // CODEX HIGH-2: connector responses (Gmail bodies, Slack messages,
    // Drive metadata) can contain emails, phones, account numbers, or
    // tokens. We scrubbed the input on the way in; we must scrub the
    // output on the way out, both for the audit row and for the bytes
    // we return to the agent (which feed straight back into the next
    // LLM call).
    const { value: scrubbedOutput, report: outputScrubReport } = scrub(forwarded.data);

    // --- 8. Audit outcome on settle ---------------------------------------
    // CODEX HIGH-4: on the SUCCESS path, a missing outcome row would
    // violate the orphan-on-success-path invariant — the side effect
    // happened but no closure record exists, AND the caller was told
    // "ok". We now fail the response when the outcome write fails so
    // the agent sees a non-success and reconciliation has matching
    // visibility on the client side. Intent stays in place; reconciler
    // still has the breadcrumb.
    try {
      await deps.audit.recordOutcome({
        intentId: intent.id,
        tenantId: verified.tenantId,
        status: 'executed',
        result: scrubbedOutput,
        resultHash: hashPayload(scrubbedOutput),
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[mcp-gateway] outcome write FAILED on success path; intent orphaned:',
        err instanceof Error ? err.message : String(err),
        { intentId: intent.id, tenantId: verified.tenantId },
      );
      return c.json(
        {
          ok: false,
          intentId: intent.id,
          error: 'audit_outcome_write_failed',
        },
        500,
      );
    }

    // Merge input + output scrub reports so the runtime sees a single
    // counts/redacted view of "what was redacted on this call".
    const mergedScrub = mergeScrubReports(scrubReport, outputScrubReport);
    return c.json({
      ok: true,
      intentId: intent.id,
      data: scrubbedOutput,
      scrub: mergedScrub,
    });
  });

  return app;
}
