import { Hono } from 'hono';
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
