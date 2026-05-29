import { Hono } from 'hono';
import { z } from 'zod';
import { hashPayload } from '@ventus/audit';
import { credentialKindForProvider } from '@ventus/credentials';
import { requireAdmin } from '../middleware/tenant.js';
import { getAppState } from '../state.js';

// Diagnostic endpoints for tenant admins. Mounted at /v1/admin. Admin-gated
// AND tenant-scoped: the reports filter tenant entries to the caller's own
// tenantId so a tenant admin cannot enumerate other tenants' runtimes (CODEX
// HIGH-1 fix). Platform-wide views are not exposed via HTTP — boot-time gates
// and operator tooling call the unscoped form in-process.

export const admin = new Hono();

// GET /v1/admin/pricing-coverage
//
// Lists every model name referenced by a skill or a tenant runtime override
// and reports whether each one has an entry in the pricing table. Operators
// use this to verify the cost ceiling is calibrated for every code path
// before flipping VENTUS_REQUIRE_PRICED_MODELS=1.
//
// Tenant entries on a free provider (e.g. ollama) are reported as priced=true
// because there's no money to attribute. Skill entries always go through the
// pricing-table check because skills don't pin a provider — the same skill
// might be routed via Anthropic for one tenant and Ollama for another.
admin.get('/pricing-coverage', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const state = getAppState();
  const report = await state.getPricingCoverageReport({ tenantId: c.var.tenantId });
  return c.json(report);
});

// GET /v1/admin/runtime-drift
//
// Diagnostic counterpart to the HIGH-1 fail-closed semantics. Lists every
// tenant whose stored runtime override names a provider that is NOT
// currently registered. The next run for any of these tenants would 503
// with TenantRuntimeDriftError — surfacing them here lets the operator
// detect drift before tenants hit a failing run, and repair via PUT
// /v1/tenant/runtime (with the correct provider) or DELETE /v1/tenant/runtime
// (revert to deployment default). registeredProviders is included so the
// operator can compare in one shot.
admin.get('/runtime-drift', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const state = getAppState();
  const report = await state.getRuntimeDriftReport({ tenantId: c.var.tenantId });
  return c.json(report);
});

// ---------------------------------------------------------------------------
// Per-tenant LLM provider keys.
//
// Stored in the same encrypted vault as connector OAuth tokens. The key
// itself never appears in the audit log or any HTTP response — only its
// SHA-256 hash + the provider name. resolveRuntimeForTenant reads these
// keys when picking a runtime so the tenant runs under their own OpenAI /
// Anthropic / OpenRouter billing scope instead of the platform-level env
// var. Providers without a stored key fall back to the platform env, which
// is the right default for single-tenant deployments and dev.

const ProviderParam = z.string().refine(
  (s) => credentialKindForProvider(s) !== null,
  { message: 'provider does not accept an API key (try openai, anthropic, openrouter)' },
);

const KeyBody = z.object({
  apiKey: z.string().min(8).max(1024),
}).strict();

// GET /v1/admin/llm-providers
//
// Lists the provider keys this tenant has stored. Metadata only — the
// plaintext key never leaves the vault. UI uses this to render
// "OpenAI: configured (updated 2026-05-29)" without ever holding the key.
admin.get('/llm-providers', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const tenantId = c.var.tenantId;
  const { credentials } = getAppState();
  const all = await credentials.list(tenantId);
  const llmOnly = all
    .filter((row) => row.connectorType.startsWith('llm_'))
    .map((row) => ({
      provider: row.connectorType.replace(/^llm_/, ''),
      updatedAt: row.updatedAt,
      ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
      keyVersion: row.keyVersion,
    }));
  return c.json({ providers: llmOnly });
});

// PUT /v1/admin/llm-providers/:provider/key
//
// Sets the tenant's API key for `provider` (openai/anthropic/openrouter).
// Body: { apiKey: string }. Re-PUTting overwrites; the prior key is not
// preserved. Audit row captures provider + key hash + length, NEVER the
// plaintext key.
admin.put('/llm-providers/:provider/key', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const tenantId = c.var.tenantId;
  const userId = c.var.userId;

  const provider = ProviderParam.safeParse(c.req.param('provider'));
  if (!provider.success) {
    return c.json({ error: provider.error.issues[0]?.message ?? 'invalid provider' }, 400);
  }
  const kind = credentialKindForProvider(provider.data)!;

  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const body = KeyBody.safeParse(parsedBody);
  if (!body.success) {
    return c.json({ error: 'apiKey required (string, 8-1024 chars)' }, 400);
  }

  const { credentials, audit } = getAppState();
  const startedAt = Date.now();
  // Audit payload: never the key itself. Hash + length is enough to prove
  // who set which key when, and to detect "is this the same key as last
  // time?" via the hash. Key VALUE recoverable only via the vault.
  const intentPayload = {
    provider: provider.data,
    apiKeyHash: hashPayload(body.data.apiKey),
    apiKeyLength: body.data.apiKey.length,
  };
  const intent = await audit.recordIntent({
    tenantId,
    stepNo: 0,
    actorType: 'user',
    actorId: userId,
    action: 'set_llm_provider_key',
    resourceType: 'llm_provider_credential',
    resourceId: provider.data,
    payload: intentPayload,
    payloadHash: hashPayload(intentPayload),
  });

  try {
    const meta = await credentials.set(tenantId, kind, body.data.apiKey, {
      updatedBy: userId,
    });
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId,
        status: 'executed',
        result: { provider: provider.data, updatedAt: meta.updatedAt },
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    return c.json({
      provider: provider.data,
      updatedAt: meta.updatedAt,
      ...(meta.updatedBy ? { updatedBy: meta.updatedBy } : {}),
      keyVersion: meta.keyVersion,
    });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId,
        status: 'failed',
        errorText: text,
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.error('PUT /v1/admin/llm-providers/:provider/key failed:', text);
    return c.json({ error: 'internal error' }, 500);
  }
});

// DELETE /v1/admin/llm-providers/:provider/key
//
// Removes the tenant's stored key for `provider`. Subsequent runs fall
// back to the platform-level env var. Idempotent — deleting an absent
// key is a 200, not a 404, so retries and "reset on logout" flows don't
// have to special-case "already gone".
admin.delete('/llm-providers/:provider/key', async (c) => {
  const denied = requireAdmin(c);
  if (denied) return denied;
  const tenantId = c.var.tenantId;
  const userId = c.var.userId;

  const provider = ProviderParam.safeParse(c.req.param('provider'));
  if (!provider.success) {
    return c.json({ error: provider.error.issues[0]?.message ?? 'invalid provider' }, 400);
  }
  const kind = credentialKindForProvider(provider.data)!;

  const { credentials, audit } = getAppState();
  const startedAt = Date.now();
  const intentPayload = { provider: provider.data };
  const intent = await audit.recordIntent({
    tenantId,
    stepNo: 0,
    actorType: 'user',
    actorId: userId,
    action: 'delete_llm_provider_key',
    resourceType: 'llm_provider_credential',
    resourceId: provider.data,
    payload: intentPayload,
    payloadHash: hashPayload(intentPayload),
  });

  try {
    await credentials.delete(tenantId, kind);
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId,
        status: 'executed',
        result: { provider: provider.data },
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    return c.json({ ok: true, provider: provider.data });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    await audit
      .recordOutcome({
        intentId: intent.id,
        tenantId,
        status: 'failed',
        errorText: text,
        durationMs: Date.now() - startedAt,
      })
      .catch(() => undefined);
    // eslint-disable-next-line no-console
    console.error('DELETE /v1/admin/llm-providers/:provider/key failed:', text);
    return c.json({ error: 'internal error' }, 500);
  }
});
