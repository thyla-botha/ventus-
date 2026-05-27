import { Hono } from 'hono';
import { z } from 'zod';
import { hashPayload } from '@ventus/audit';
import { MAX_TENANT_PROFILE_LEN } from '@ventus/store';
import { requireAdmin } from '../middleware/tenant.js';
import { getAppState } from '../state.js';

// Bounded, read-only-at-runtime tenant context block.
//
//   GET    /v1/tenant/profile     fetch the caller's tenant profile (200 + body | 404)
//   PUT    /v1/tenant/profile     replace it — admin only (200 + body)
//   DELETE /v1/tenant/profile     remove it — admin only (204; idempotent)
//
// "Caller's tenant" = c.var.tenantId, set by tenantContext middleware. There
// is intentionally no admin route that takes a tenantId in the body or path —
// cross-tenant writes would defeat the safety story.
//
// WRITE = ADMIN ONLY. The profile body is injected into the system prompt of
// every agent run for the tenant, so editing it is effectively editing the
// org-wide prompt. A junior support user must NOT be able to rewrite the
// prompt that drafts customer comms. Reads stay open to all tenant members —
// visibility is fine; mutation is the privilege boundary.
//
// TODO(auth): the role itself is currently header-derived (x-user-role) in
// the tenantContext middleware. When real auth lands the role MUST come from
// verified session claims (Supabase custom claims / JWT) and the header
// shortcut MUST be removed. Until then, callers can spoof a role and this
// guard is dev-only protection.

const putSchema = z.object({
  body: z.string().max(MAX_TENANT_PROFILE_LEN),
});

// Runtime overrides are bounded so a typo can't push multi-kilobyte values
// into the file row. 64 chars covers any realistic provider name (registered
// keys are short identifiers) and model id (e.g. 'anthropic/claude-opus-4-7'
// or 'openrouter/auto') with headroom.
const MAX_RUNTIME_FIELD_LEN = 64;
// Mirrors UNSAFE_CHARS_RE in the store layer: C0/C1 control bytes, DEL,
// and Unicode line separators (U+2028/U+2029). The store also rejects
// these as defense-in-depth, but rejecting at the route gives the admin
// a 400 with a clear schema error instead of bubbling a store throw up
// to the 500 classifier. Codex round-10 P2.
const UNSAFE_RUNTIME_FIELD_RE = /[\x00-\x1F\x7F-\x9F\u2028\u2029]/u;
const safeRuntimeField = z
  .string()
  .min(1)
  .max(MAX_RUNTIME_FIELD_LEN)
  .refine((s) => !UNSAFE_RUNTIME_FIELD_RE.test(s), {
    message: 'must not contain control or line-separator characters',
  });
const putRuntimeSchema = z.object({
  provider: safeRuntimeField,
  model: safeRuntimeField,
});

export const tenantProfile = new Hono()
  .get('/profile', async (c) => {
    const tenantId = c.var.tenantId;
    const { tenantProfiles } = getAppState();
    const profile = await tenantProfiles.get(tenantId);
    if (!profile) return c.json({ error: 'not found' }, 404);
    return c.json({ profile });
  })
  .put('/profile', async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const parsed = putSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.format() }, 400);
    }
    const { tenantProfiles, audit } = getAppState();

    // Audit the profile write BEFORE applying it. The body is hashed (not
    // copied verbatim) so the audit trail proves who set what without
    // duplicating the full prompt every time. The "what" is recoverable
    // from the tenant_profiles row at the recorded timestamp — and once
    // we add a history table (see [[project-deferred-backlog]]) the
    // intent's bodyHash will pin to a specific version row.
    const startedAt = Date.now();
    const intentPayload = {
      bodyLength: parsed.data.body.length,
      bodyHash: hashPayload(parsed.data.body),
    };
    const intent = await audit.recordIntent({
      tenantId,
      stepNo: 0,
      actorType: 'user',
      actorId: userId,
      action: 'set_tenant_profile',
      resourceType: 'tenant_profile',
      resourceId: tenantId,
      payload: intentPayload,
      payloadHash: hashPayload(intentPayload),
    });

    try {
      const profile = await tenantProfiles.set(tenantId, parsed.data.body, {
        updatedBy: userId,
      });
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'executed',
          result: { contentHash: profile.contentHash, updatedAt: profile.updatedAt },
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      return c.json({ profile });
    } catch (err) {
      // Store enforces the length cap independently of the schema (defense
      // in depth — the cap MUST be a store invariant, not just an HTTP one).
      const text = err instanceof Error ? err.message : String(err);
      const isClientError = /exceeds .* chars/.test(text);
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'failed',
          errorText: text,
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      if (isClientError) return c.json({ error: text }, 400);
      // eslint-disable-next-line no-console
      console.error('PUT /v1/tenant/profile failed:', err);
      return c.json({ error: 'internal error' }, 500);
    }
  })
  // DELETE is implemented as "set to empty string" — keeps the contentHash
  // story consistent (empty profile is still a snapshot, just hashes to the
  // empty-string sha) without a second code path in the store.
  .delete('/profile', async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const { tenantProfiles, audit } = getAppState();

    const startedAt = Date.now();
    const intent = await audit.recordIntent({
      tenantId,
      stepNo: 0,
      actorType: 'user',
      actorId: userId,
      action: 'clear_tenant_profile',
      resourceType: 'tenant_profile',
      resourceId: tenantId,
    });

    try {
      const profile = await tenantProfiles.set(tenantId, '', { updatedBy: userId });
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'executed',
          result: { contentHash: profile.contentHash, updatedAt: profile.updatedAt },
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      return c.body(null, 204);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      throw err;
    }
  })
  // PUT/DELETE /runtime — manage the tenant's per-tenant runtime override.
  // Independent of the profile body so changing providers doesn't churn the
  // contentHash (and vice versa). Audit-before-execute, same as profile body
  // writes: an admin reconfiguring which model runs the agent is at LEAST
  // as significant as editing the prompt.
  //
  // Provider is validated against the live RuntimeRegistry on write so a
  // typo doesn't surface as a 503 at the next run. The list of registered
  // providers comes from state.listRuntimeProviders().
  .put('/runtime', async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const parsed = putRuntimeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.format() }, 400);
    }
    const state = getAppState();
    if (!state.hasRuntimeProvider(parsed.data.provider)) {
      return c.json(
        {
          error: `unknown runtime provider: ${parsed.data.provider}`,
          providers: state.listRuntimeProviders(),
        },
        400,
      );
    }
    const { tenantProfiles, audit } = state;

    const startedAt = Date.now();
    const intentPayload = {
      provider: parsed.data.provider,
      model: parsed.data.model,
    };
    const intent = await audit.recordIntent({
      tenantId,
      stepNo: 0,
      actorType: 'user',
      actorId: userId,
      action: 'set_tenant_runtime',
      resourceType: 'tenant_profile',
      resourceId: tenantId,
      payload: intentPayload,
      payloadHash: hashPayload(intentPayload),
    });

    try {
      const profile = await tenantProfiles.setRuntime(
        tenantId,
        { provider: parsed.data.provider, model: parsed.data.model },
        { updatedBy: userId },
      );
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'executed',
          result: {
            runtime: profile.runtime,
            runtimeUpdatedAt: profile.runtimeUpdatedAt,
          },
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      return c.json({ profile });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      // Any store-layer assertSafeRuntimeField throw is structurally client
      // input — the zod schema rejects these too, so this branch is mostly
      // belt-and-braces, but a direct repair script or future Postgres
      // adapter that bypasses the route still gets a clean 400 here.
      // Codex round-10 P2.
      const isClientError =
        /must be a non-empty string/.test(errorText) ||
        /contains control or line-separator characters/.test(errorText) ||
        /exceeds \d+ chars/.test(errorText);
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      if (isClientError) return c.json({ error: errorText }, 400);
      // eslint-disable-next-line no-console
      console.error('PUT /v1/tenant/runtime failed:', err);
      return c.json({ error: 'internal error' }, 500);
    }
  })
  .delete('/runtime', async (c) => {
    const forbidden = requireAdmin(c);
    if (forbidden) return forbidden;
    const tenantId = c.var.tenantId;
    const userId = c.var.userId;
    const { tenantProfiles, audit } = getAppState();

    const startedAt = Date.now();
    const intent = await audit.recordIntent({
      tenantId,
      stepNo: 0,
      actorType: 'user',
      actorId: userId,
      action: 'clear_tenant_runtime',
      resourceType: 'tenant_profile',
      resourceId: tenantId,
    });

    try {
      const profile = await tenantProfiles.setRuntime(tenantId, null, {
        updatedBy: userId,
      });
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'executed',
          result: { runtime: null, runtimeUpdatedAt: profile.runtimeUpdatedAt },
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      return c.body(null, 204);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      await audit
        .recordOutcome({
          intentId: intent.id,
          tenantId,
          status: 'failed',
          errorText,
          durationMs: Date.now() - startedAt,
        })
        .catch(() => undefined);
      throw err;
    }
  });
