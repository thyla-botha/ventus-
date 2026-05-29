import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FileAuditStore,
  FileProposalStore,
  FileRunStore,
  FileTenantProfileStore,
  type AuditStore,
  type ProposalStore,
  type RunStore,
  type TenantProfileStore,
} from '@ventus/store';
import {
  FakeAgentRuntime,
  buildDefaultRuntimeRegistry,
  buildLocalRegistry,
  hasModelPricing,
  providerChargesForUsage,
  RuntimeRegistry,
  type AgentRuntime,
  type ExecutorRegistry,
} from '@ventus/agent-runtime';
import {
  FileCredentialStore,
  credentialKindForProvider,
  type CredentialStore,
} from '@ventus/credentials';
import { discoverSkills, type Skill } from '@ventus/skills';

// Process-wide singletons for the file-backed stores. Every route handler
// shares these so concurrent requests serialize through the same per-instance
// writeLock. When we move to Postgres we swap these for DB-backed stores
// behind the same interfaces and the routes don't change.
//
// Paths default to <workspace-root>/.ventus/ so the API, CLI, and any future
// worker all read/write the same files regardless of which cwd they're run
// from. Override with VENTUS_PROPOSAL_STORE / VENTUS_AUDIT_STORE / VENTUS_OUTBOX.

function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

const ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));

const PROPOSAL_STORE_PATH = process.env.VENTUS_PROPOSAL_STORE
  ? resolve(process.env.VENTUS_PROPOSAL_STORE)
  : resolve(ROOT, '.ventus/proposals.json');

const AUDIT_STORE_PATH = process.env.VENTUS_AUDIT_STORE
  ? resolve(process.env.VENTUS_AUDIT_STORE)
  : resolve(ROOT, '.ventus/audit.json');

const OUTBOX_PATH = process.env.VENTUS_OUTBOX
  ? resolve(process.env.VENTUS_OUTBOX)
  : resolve(ROOT, '.ventus/outbox.json');

const RUN_STORE_PATH = process.env.VENTUS_RUN_STORE
  ? resolve(process.env.VENTUS_RUN_STORE)
  : resolve(ROOT, '.ventus/runs.json');

const TENANT_PROFILE_PATH = process.env.VENTUS_TENANT_PROFILE_STORE
  ? resolve(process.env.VENTUS_TENANT_PROFILE_STORE)
  : resolve(ROOT, '.ventus/tenant-profiles.json');

// Per-tenant credential vault. Shared with the mcp-gateway in deployments
// where both run side-by-side — set VENTUS_CREDENTIAL_STORE to the same
// path on both processes so a credential PUT through the API is visible
// to a tool-call PROXY through the gateway and vice versa.
const CREDENTIAL_STORE_PATH = process.env.VENTUS_CREDENTIAL_STORE
  ? resolve(process.env.VENTUS_CREDENTIAL_STORE)
  : resolve(ROOT, '.ventus/credentials.json');

const SKILLS_DIR = process.env.VENTUS_SKILLS_DIR
  ? resolve(process.env.VENTUS_SKILLS_DIR)
  : resolve(ROOT, 'skills');

// One row of the pricing-coverage report. `source` is where the model name
// came from (a skill frontmatter, or a tenant's runtime override). `provider`
// is null for skill entries because skills don't pin a provider — the routing
// depends on per-tenant config at run time. For tenant entries, `provider` is
// the registered provider name from the override. `priced` reports whether
// the model has an entry in the pricing table (custom or built-in). For
// tenant entries on a free provider (`providerChargesForUsage === false`,
// e.g. ollama) `priced` is forced true because pricing-table coverage is
// irrelevant when no money changes hands.
export interface PricingCoverageEntry {
  source: 'skill' | 'tenant';
  identifier: string;
  provider: string | null;
  model: string;
  priced: boolean;
}

// `ok` is true iff every entry is `priced`. The boot-time gate
// (VENTUS_REQUIRE_PRICED_MODELS=1) refuses to start the process if `ok`
// is false; otherwise this report is purely diagnostic and exposed via
// GET /v1/admin/pricing-coverage so operators can sweep for gaps.
export interface PricingCoverageReport {
  entries: readonly PricingCoverageEntry[];
  ok: boolean;
  unpricedCount: number;
}

// One row of the runtime-drift report. A tenant has runtime drift when its
// stored override names a provider that is no longer registered (env change
// dropped the provider, mis-spelled name in a manual write, registry refactor
// between writes and now). Each drift entry is a tenant whose next run would
// 503 with TenantRuntimeDriftError — the operator surfaces them via
// GET /v1/admin/runtime-drift and repairs proactively.
export interface RuntimeDriftEntry {
  tenantId: string;
  provider: string;
  model: string;
  runtimeUpdatedAt?: string;
  runtimeUpdatedBy?: string;
}

export interface RuntimeDriftReport {
  entries: readonly RuntimeDriftEntry[];
  // The set of provider names currently registered. Included so the operator
  // can see "the override points at X, registered providers are [Y, Z]"
  // without a second round-trip.
  registeredProviders: readonly string[];
}

export interface AppState {
  proposals: ProposalStore;
  audit: AuditStore;
  runs: RunStore;
  tenantProfiles: TenantProfileStore;
  // Per-tenant secrets vault. Today holds: connector OAuth tokens
  // (gmail/slack/etc., consumed by mcp-gateway forwarders) AND
  // per-tenant LLM provider API keys (llm_openai/llm_anthropic/
  // llm_openrouter, consumed by resolveRuntimeForTenant when picking the
  // runtime). Same encryption, same per-tenant subkey, same audit story.
  credentials: CredentialStore;
  registry: ExecutorRegistry;
  // The AgentRuntime used when an HTTP request kicks off a run. Lazy because
  // AnthropicRuntime throws on construction without ANTHROPIC_API_KEY — we
  // only want that to surface when a run is actually requested. Tests inject
  // a FakeAgentRuntime via setRuntimeForTests().
  //
  // No-tenant form: returns the deployment default (env or test override).
  // Used by tests and any caller that doesn't have a tenant in scope.
  getRuntime: () => AgentRuntime;
  // Per-tenant form: looks up the tenant's runtime override (if any) and
  // returns the bundle the run-spawning code needs. Falls back to the
  // deployment default only when the tenant has NO override. If the tenant
  // HAS an override but the named provider is no longer registered, this
  // FAILS CLOSED — throws TenantRuntimeDriftError. Reason: a regulated
  // tenant pinned to (e.g.) ollama for data-residency must NEVER silently
  // run under the cloud default after a registry change. Falling back
  // would exfiltrate prompts past the trust boundary. The drift case is
  // surfaced via /v1/admin/runtime-drift so operators can detect + repair
  // before runs start failing. Codex round-9 HIGH.
  resolveRuntimeForTenant: (
    tenantId: string,
  ) => Promise<{ runtime: AgentRuntime; modelOverride?: string }>;
  // True iff `provider` is registered in the runtime registry. Routes use
  // this to validate tenant runtime config on write so a typo doesn't
  // surface as a 503 at the next run.
  hasRuntimeProvider: (provider: string) => boolean;
  // List registered provider names. Surfaced to clients via the admin
  // endpoint so the UI can present a dropdown.
  listRuntimeProviders: () => string[];
  // Pricing-coverage report. Walks the skill catalog and every tenant
  // runtime override and checks whether each named model has an entry in
  // the pricing table. Used by the GET /v1/admin/pricing-coverage endpoint
  // and by the optional boot-time gate (VENTUS_REQUIRE_PRICED_MODELS=1).
  // A run that costs out using the fallback price is a calibration risk —
  // the cost ceiling stops being a real number when the cost is wrong.
  //
  // Tenant scoping: pass { tenantId } to restrict tenant entries to that
  // tenant only — required for API admin routes so a tenant admin cannot
  // enumerate other tenants' runtimes (CODEX HIGH-1). Skill entries are
  // always included because they carry no tenant identity. Omitting the
  // arg returns the platform-wide view, used only by the boot-time gate.
  getPricingCoverageReport: (opts?: {
    tenantId?: string;
  }) => Promise<PricingCoverageReport>;
  // Runtime-drift report. Lists tenants whose stored runtime override
  // points at an unregistered provider. The next run for each of these
  // tenants would 503 (TenantRuntimeDriftError) — the report is the
  // operator-facing surface that lets them detect drift BEFORE the
  // tenant hits a failing run. Diagnostic counterpart to HIGH-1.
  //
  // Tenant scoping: pass { tenantId } to restrict to that tenant only
  // (CODEX HIGH-1). Omitting returns the platform-wide view — reserved
  // for in-process operator tooling, NOT exposed to admin routes.
  getRuntimeDriftReport: (opts?: {
    tenantId?: string;
  }) => Promise<RuntimeDriftReport>;
  // Lazy skill catalog. Loaded on first request — the directory is global to
  // the platform (not tenant-scoped). Returns a fresh promise on cache reset.
  getSkills: () => Promise<Skill[]>;
  // Track in-flight agent runs so graceful shutdown (and tests) can wait for
  // them to close their Run rows before exiting. Without this, a SIGTERM
  // mid-loop would orphan rows in 'running'.
  trackInflight: (p: Promise<unknown>) => void;
  drainInflight: () => Promise<void>;
  // Per-tenant concurrency cap on agent loops. tryClaimRunSlot atomically
  // checks the counter against perTenantRunCap and increments if under the
  // limit. releaseRunSlot decrements on loop settle. Single-threaded Node,
  // so Map ops are naturally atomic — no locking required.
  tryClaimRunSlot: (tenantId: string) => boolean;
  releaseRunSlot: (tenantId: string) => void;
  perTenantRunCap: number;
  paths: {
    proposals: string;
    audit: string;
    runs: string;
    outbox: string;
    skills: string;
    tenantProfiles: string;
  };
}

// Thrown by resolveRuntimeForTenant when the tenant has a stored runtime
// override whose provider is no longer registered (env drift, mistyped
// admin write that escaped validation, registry change between writes
// and now). The HTTP layer translates this to a 503 with a clear
// "tenant runtime stale" error so the operator can fix the config
// instead of having the run silently fall back to a different provider.
// Codex round-9 HIGH — fail-closed.
export class TenantRuntimeDriftError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly provider: string,
  ) {
    super(
      `tenant=${tenantId} runtime.provider=${provider} is not registered; ` +
        `refusing to run (would have to fall back to a different provider, ` +
        `which violates data-residency assumptions). ` +
        `Repair via PUT /v1/tenant/runtime or DELETE /v1/tenant/runtime.`,
    );
    this.name = 'TenantRuntimeDriftError';
  }
}

let cached: AppState | null = null;
let runtimeOverride: AgentRuntime | null = null;
// Tests can install a custom registry (e.g. with a 'fake' provider) before
// the first getAppState() of a case. Reset via setRuntimeRegistryForTests(null).
// Production code never sets this — the default registry is used.
let customRuntimeRegistry: RuntimeRegistry | null = null;

export function getAppState(): AppState {
  if (cached) return cached;
  const proposals = process.env.VENTUS_PROPOSAL_STORE
    ? resolve(process.env.VENTUS_PROPOSAL_STORE)
    : PROPOSAL_STORE_PATH;
  const auditPath = process.env.VENTUS_AUDIT_STORE
    ? resolve(process.env.VENTUS_AUDIT_STORE)
    : AUDIT_STORE_PATH;
  const outbox = process.env.VENTUS_OUTBOX ? resolve(process.env.VENTUS_OUTBOX) : OUTBOX_PATH;
  const runsPath = process.env.VENTUS_RUN_STORE
    ? resolve(process.env.VENTUS_RUN_STORE)
    : RUN_STORE_PATH;
  const tenantProfilesPath = process.env.VENTUS_TENANT_PROFILE_STORE
    ? resolve(process.env.VENTUS_TENANT_PROFILE_STORE)
    : TENANT_PROFILE_PATH;
  const skillsDir = process.env.VENTUS_SKILLS_DIR
    ? resolve(process.env.VENTUS_SKILLS_DIR)
    : SKILLS_DIR;

  // Skills are discovered from disk on first request and memoised for the
  // lifetime of the AppState. Skill files are platform-global (not tenant
  // scoped) so caching is safe across tenants.
  let skillsPromise: Promise<Skill[]> | null = null;
  function skillCatalog(): Promise<Skill[]> {
    if (!skillsPromise) skillsPromise = discoverSkills(skillsDir);
    return skillsPromise;
  }

  // In-flight agent loops. Each entry removes itself on settle so the Set
  // never grows unbounded. drainInflight() awaits whatever is still open.
  const inflight = new Set<Promise<unknown>>();

  // Per-tenant in-process counter. Counts agent loops currently driven by
  // THIS process — a row stuck in 'running' that this process didn't start
  // (e.g. left over from a crashed peer) is not counted here. The reaper
  // closes those; this counter is purely a fair-use throttle on live work.
  //
  // Cap source: VENTUS_PER_TENANT_RUN_CAP env, default 5. Read once at
  // AppState construction so the cap is stable for the process lifetime —
  // changing the env mid-run requires a process bounce, which matches how
  // the rest of the config (paths, runtime) is wired.
  const perTenantRunCap = (() => {
    const raw = process.env.VENTUS_PER_TENANT_RUN_CAP;
    if (raw === undefined || raw === '') return 5;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
      // eslint-disable-next-line no-console
      console.warn(
        `VENTUS_PER_TENANT_RUN_CAP=${raw} is not a positive integer; falling back to 5`,
      );
      return 5;
    }
    return n;
  })();
  const slotsByTenant = new Map<string, number>();

  // Runtime selection: registry of provider→factory, picked by
  // VENTUS_RUNTIME_PROVIDER env (default 'anthropic'). Per-tenant overrides
  // are resolved at run-spawn time via resolveRuntimeForTenant() — see
  // TenantProfile.runtime. Tests can swap the registry via
  // setRuntimeRegistryForTests() to register additional providers (e.g.
  // a fake) without touching env.
  const runtimeRegistry = customRuntimeRegistry ?? buildDefaultRuntimeRegistry();
  const defaultProvider = (process.env.VENTUS_RUNTIME_PROVIDER ?? 'anthropic').trim() || 'anthropic';

  const tenantProfileStore = new FileTenantProfileStore(tenantProfilesPath);
  const credentialStorePath = process.env.VENTUS_CREDENTIAL_STORE
    ? resolve(process.env.VENTUS_CREDENTIAL_STORE)
    : CREDENTIAL_STORE_PATH;
  const credentialStore = new FileCredentialStore(credentialStorePath);

  // Factor out the default-provider construction so getRuntime() and
  // resolveRuntimeForTenant() share one fallback path. The dev-fake
  // affordance and runtimeOverride still take precedence.
  function defaultRuntime(): AgentRuntime {
    if (runtimeOverride) return runtimeOverride;
    if (process.env.VENTUS_DEV_FAKE_RUNTIME === '1') {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          'VENTUS_DEV_FAKE_RUNTIME=1 is set but NODE_ENV=production. ' +
            'Refusing to serve scripted fake runtime in production.',
        );
      }
      return new FakeAgentRuntime({
        turns: [
          {
            tools: [
              {
                name: 'create_proposal',
                input: {
                  action_type: 'draft_email_reply',
                  payload: {
                    to: 'customer@example.com',
                    subject: 'Re: your inquiry',
                    body: '[dev fake] This is a scripted draft from VENTUS_DEV_FAKE_RUNTIME=1. Replace with a real ANTHROPIC_API_KEY to test the live model.',
                  },
                  confidence: 0.5,
                },
              },
            ],
          },
          { text: 'Drafted a reply for review.' },
        ],
      });
    }
    return runtimeRegistry.create(defaultProvider);
  }

  cached = {
    proposals: new FileProposalStore(proposals),
    audit: new FileAuditStore(auditPath),
    runs: new FileRunStore(runsPath),
    tenantProfiles: tenantProfileStore,
    credentials: credentialStore,
    registry: buildLocalRegistry(outbox),
    getRuntime: () => defaultRuntime(),
    resolveRuntimeForTenant: async (tenantId: string) => {
      // Tests / dev-fake always short-circuit to the global override —
      // a tenant config pointing at a real provider must not punch
      // through a deliberate test fixture.
      if (runtimeOverride) return { runtime: runtimeOverride };
      if (process.env.VENTUS_DEV_FAKE_RUNTIME === '1') {
        return { runtime: defaultRuntime() };
      }
      const profile = await tenantProfileStore.get(tenantId);
      const cfg = profile?.runtime;
      if (cfg && runtimeRegistry.has(cfg.provider)) {
        // Per-tenant API key, if any. The vault returns null when the
        // tenant hasn't uploaded their own key — the factory then falls
        // back to the process-level env var (OPENAI_API_KEY etc.), which
        // is the right default for single-tenant deployments and dev.
        // Providers that don't take an API key (ollama) skip this entirely.
        const credentialKind = credentialKindForProvider(cfg.provider);
        let apiKey: string | null = null;
        if (credentialKind !== null) {
          apiKey = await credentialStore.get(tenantId, credentialKind);
        }
        return {
          runtime: runtimeRegistry.create(
            cfg.provider,
            apiKey ? { apiKey } : undefined,
          ),
          modelOverride: cfg.model,
        };
      }
      // Drift case (codex round-9 HIGH): tenant has runtime config but
      // the named provider is no longer registered. Fail CLOSED — falling
      // back to the deployment default would silently exfiltrate prompts
      // for a tenant that pinned to (e.g.) ollama for data-residency.
      // Operators discover drift proactively via /v1/admin/runtime-drift
      // and repair before runs start failing.
      if (cfg && !runtimeRegistry.has(cfg.provider)) {
        // eslint-disable-next-line no-console
        console.error(
          `tenant=${tenantId} runtime.provider=${cfg.provider} is not registered; refusing to run (use /v1/admin/runtime-drift to inventory)`,
        );
        throw new TenantRuntimeDriftError(tenantId, cfg.provider);
      }
      return { runtime: defaultRuntime() };
    },
    hasRuntimeProvider: (provider: string) => runtimeRegistry.has(provider),
    listRuntimeProviders: () => runtimeRegistry.providers(),
    getPricingCoverageReport: async (opts) => {
      // Two independent sources of model names:
      //   1. Skill frontmatter — each skill names a default model. We don't
      //      know which provider will route it at run time, so we just check
      //      pricing-table presence by model name. If the same model name
      //      appears in two skills we still emit two rows (the caller may
      //      want per-skill traceability).
      //   2. Tenant runtime overrides — these carry both provider and model,
      //      so we skip coverage checks when the provider is in the
      //      free-tier set (ollama). Without that skip every ollama tenant
      //      would falsely fail the boot gate.
      const entries: PricingCoverageEntry[] = [];
      const skills = await skillCatalog();
      for (const s of skills) {
        entries.push({
          source: 'skill',
          identifier: s.name,
          provider: null,
          model: s.model,
          priced: hasModelPricing(s.model),
        });
      }
      const profiles = await tenantProfileStore.list();
      const scope = opts?.tenantId;
      for (const p of profiles) {
        if (!p.runtime) continue;
        if (scope && p.tenantId !== scope) continue;
        const chargesForUsage = providerChargesForUsage(p.runtime.provider);
        const priced = !chargesForUsage || hasModelPricing(p.runtime.model);
        entries.push({
          source: 'tenant',
          identifier: p.tenantId,
          provider: p.runtime.provider,
          model: p.runtime.model,
          priced,
        });
      }
      const unpricedCount = entries.reduce((n, e) => n + (e.priced ? 0 : 1), 0);
      return { entries, ok: unpricedCount === 0, unpricedCount };
    },
    getRuntimeDriftReport: async (opts) => {
      const profiles = await tenantProfileStore.list();
      const scope = opts?.tenantId;
      const entries: RuntimeDriftEntry[] = [];
      for (const p of profiles) {
        if (!p.runtime) continue;
        if (scope && p.tenantId !== scope) continue;
        if (runtimeRegistry.has(p.runtime.provider)) continue;
        entries.push({
          tenantId: p.tenantId,
          provider: p.runtime.provider,
          model: p.runtime.model,
          runtimeUpdatedAt: p.runtimeUpdatedAt,
          runtimeUpdatedBy: p.runtimeUpdatedBy,
        });
      }
      return { entries, registeredProviders: runtimeRegistry.providers() };
    },
    getSkills: () => skillCatalog(),
    trackInflight: (p) => {
      // Settle into a swallowed promise so the Set member never rejects
      // (otherwise Promise.all in drainInflight would short-circuit). We
      // still LOG the rejection — a rejected completion means the loop
      // could not close the Run row, which leaves it stuck in 'running'.
      // Catching silently here would hide that incident.
      const settled = p
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('inflight run completion rejected:', err);
        })
        .finally(() => inflight.delete(settled));
      inflight.add(settled);
    },
    // drainInflight() snapshots the current Set and awaits its contents.
    // For graceful shutdown, the server MUST stop accepting new requests
    // first (e.g. close the HTTP listener) — otherwise late arrivals after
    // the snapshot will not be awaited.
    drainInflight: () => Promise.all([...inflight]).then(() => undefined),
    tryClaimRunSlot: (tenantId) => {
      const current = slotsByTenant.get(tenantId) ?? 0;
      if (current >= perTenantRunCap) return false;
      slotsByTenant.set(tenantId, current + 1);
      return true;
    },
    releaseRunSlot: (tenantId) => {
      const current = slotsByTenant.get(tenantId) ?? 0;
      if (current === 0) {
        // Defensive: a release without a matching claim means the
        // accounting got out of sync (double-release, or release-for-untracked
        // tenant). Log loudly so the bug surfaces — silently no-op'ing here
        // would mask whatever inflated the cap headroom for this tenant.
        // eslint-disable-next-line no-console
        console.warn(
          `releaseRunSlot: no slot to release for tenant=${tenantId} (double-release?)`,
        );
        return;
      }
      if (current === 1) {
        // Delete on zero to keep the Map from accumulating one entry per
        // tenant we've ever seen. With many short-lived tenants this matters.
        slotsByTenant.delete(tenantId);
        return;
      }
      slotsByTenant.set(tenantId, current - 1);
    },
    perTenantRunCap,
    paths: {
      proposals,
      audit: auditPath,
      runs: runsPath,
      outbox,
      skills: skillsDir,
      tenantProfiles: tenantProfilesPath,
    },
  };
  return cached;
}

// Test-only: clears the cached singleton so the next getAppState() rebuilds
// against the current env vars. Production code never calls this — the API
// process holds one set of stores for its lifetime.
export function resetAppState(): void {
  cached = null;
}

// Test-only: install a fake runtime. Call BEFORE the first getAppState() of
// each test (or pair with resetAppState()). Pass null to clear and fall back
// to the registry-default runtime on next bind.
export function setRuntimeForTests(runtime: AgentRuntime | null): void {
  runtimeOverride = runtime;
  cached = null;
}

// Test-only: install a custom RuntimeRegistry so tests can register provider
// factories (e.g. a 'fake' provider) without setting env. Pass null to clear
// and fall back to buildDefaultRuntimeRegistry() on next bind. Resets the
// cached AppState so the next getAppState() picks up the new registry.
export function setRuntimeRegistryForTests(registry: RuntimeRegistry | null): void {
  customRuntimeRegistry = registry;
  cached = null;
}
