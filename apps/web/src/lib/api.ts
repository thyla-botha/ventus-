// Thin wrapper around the Hono API. Always called from server components or
// server actions — never from the client — so we don't deal with CORS and
// can pass the tenant/user headers directly. When auth lands these headers
// come from the session; for now they default to the dev tenant.

const API_BASE = process.env.VENTUS_API_URL ?? 'http://localhost:8080';
const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const DEV_USER_ID = '00000000-0000-0000-0000-000000000001';

export interface ProposalRow {
  id: string;
  tenantId: string;
  runId: string;
  agentId: string;
  actionType: string;
  resourceType?: string;
  resourceId?: string;
  payload: unknown;
  evidence?: unknown[];
  expectedOutcome?: string;
  confidence?: number;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  decision?: {
    approverId: string;
    verdict: 'approved' | 'rejected' | 'edited';
    comment?: string;
    editedPayload?: unknown;
    decidedAt: string;
  };
  // Snapshot hash of the Run that produced this proposal — see RunRow.
  contextSnapshotHash?: string;
}

export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired';

// TODO(auth): trust boundary lives here for now — every server-side fetch
// goes out with header-derived tenant/user that defaults to the dev tenant.
// Before any real multi-tenant deployment this MUST be replaced with values
// read from the request session (Supabase auth or equivalent), so that the
// API's tenantContext middleware actually gates on authenticated state. See
// also apps/api/src/middleware/tenant.ts and the matching prod TODO there.
function authHeaders(opts: { asAdmin?: boolean } = {}): Record<string, string> {
  const h: Record<string, string> = {
    'x-tenant-id': process.env.VENTUS_TENANT_ID ?? DEV_TENANT_ID,
    'x-user-id': process.env.VENTUS_USER_ID ?? DEV_USER_ID,
  };
  // TODO(auth): admin role is currently header-asserted. Until real session
  // claims land, the settings UI elevates the dev caller to admin for writes
  // and admin diagnostics. Production callers MUST derive the role from
  // verified JWT claims and drop the header path entirely.
  if (opts.asAdmin) h['x-user-role'] = 'admin';
  return h;
}

interface HttpOptions extends RequestInit {
  asAdmin?: boolean;
}

async function http<T>(path: string, init: HttpOptions = {}): Promise<T> {
  const { asAdmin, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    cache: 'no-store',
    headers: {
      ...authHeaders({ asAdmin }),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function listProposals(status?: ProposalStatus): Promise<ProposalRow[]> {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await http<{ proposals: ProposalRow[] }>(`/v1/proposals${q}`);
  return data.proposals;
}

export async function getProposal(id: string): Promise<ProposalRow | null> {
  try {
    const data = await http<{ proposal: ProposalRow }>(`/v1/proposals/${id}`);
    return data.proposal;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('404')) return null;
    throw err;
  }
}

export async function decideProposal(
  id: string,
  body: { verdict: 'approved' | 'rejected'; comment?: string; editedPayload?: unknown },
): Promise<ProposalRow> {
  const data = await http<{ proposal: ProposalRow }>(`/v1/proposals/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.proposal;
}

export async function executeProposalHttp(id: string): Promise<{
  result: { status: string; result?: unknown; error?: string };
  proposal: ProposalRow;
}> {
  return http<{
    result: { status: string; result?: unknown; error?: string };
    proposal: ProposalRow;
  }>(`/v1/proposals/${id}/execute`, { method: 'POST' });
}

// ----------------------------------------------------------------------------
// Audit trail
// ----------------------------------------------------------------------------

export interface AuditIntent {
  id: string;
  tenantId: string;
  runId?: string;
  stepNo: number;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  toolName?: string;
  payload?: unknown;
  payloadHash?: string;
  proposedAt: string;
  contextSnapshotHash?: string;
}

export interface AuditOutcome {
  id: string;
  intentId: string;
  tenantId: string;
  status:
    | 'executed'
    | 'failed'
    | 'rolled_back'
    | 'approved'
    | 'rejected'
    | 'timeout'
    | 'dropped';
  result?: unknown;
  resultHash?: string;
  errorText?: string;
  durationMs?: number;
  costUsdMicros?: number;
  recordedAt: string;
}

export interface AuditTrailRow {
  intent: AuditIntent;
  outcome: AuditOutcome | null;
}

export interface AuditTrailQuery {
  resourceType?: string;
  resourceId?: string;
  runId?: string;
  limit?: number;
}

export async function listAuditTrail(query: AuditTrailQuery = {}): Promise<AuditTrailRow[]> {
  const params = new URLSearchParams();
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.resourceId) params.set('resourceId', query.resourceId);
  if (query.runId) params.set('runId', query.runId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  const data = await http<{ events: AuditTrailRow[] }>(`/v1/audit${qs ? `?${qs}` : ''}`);
  return data.events;
}

// ----------------------------------------------------------------------------
// Runs
// ----------------------------------------------------------------------------

export type RunStatus = 'running' | 'completed' | 'failed' | 'halted' | 'aborted';

export interface RunRow {
  id: string;
  tenantId: string;
  agentId: string;
  skillId?: string;
  model?: string;
  userMessage?: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  totalCostMicros?: number;
  proposalCount?: number;
  finalText?: string;
  haltReason?: string;
  errorText?: string;
  cancelRequestedAt?: string;
  cancelRequestedBy?: string;
  // Provenance — see packages/store/src/types.ts RunRecord. Hex SHA-256s.
  skillContentHash?: string;
  contextSnapshotHash?: string;
  // Hash of the tenant_profile that was injected at run time, or null when
  // the tenant had no profile. Undefined for legacy rows that predate the
  // tenant_profile feature.
  tenantProfileHash?: string | null;
}

export interface RunsListQuery {
  status?: RunStatus;
  agentId?: string;
  limit?: number;
}

export async function listRuns(query: RunsListQuery = {}): Promise<RunRow[]> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.agentId) params.set('agentId', query.agentId);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  const data = await http<{ runs: RunRow[] }>(`/v1/runs${qs ? `?${qs}` : ''}`);
  return data.runs;
}

export async function getRun(id: string): Promise<RunRow | null> {
  try {
    const data = await http<{ run: RunRow }>(`/v1/runs/${id}`);
    return data.run;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('404')) return null;
    throw err;
  }
}

export async function listRunProposals(id: string): Promise<ProposalRow[]> {
  const data = await http<{ proposals: ProposalRow[] }>(`/v1/runs/${id}/proposals`);
  return data.proposals;
}

export async function listRunAudit(id: string, limit = 200): Promise<AuditTrailRow[]> {
  const data = await http<{ events: AuditTrailRow[] }>(
    `/v1/runs/${id}/audit?limit=${limit}`,
  );
  return data.events;
}

// POST /v1/runs returns 202 + the open Run row. The agent loop continues in
// the background; clients should redirect to /runs/[id] and poll.
export async function createRun(body: {
  skillName: string;
  message: string;
  agentId?: string;
}): Promise<RunRow> {
  const data = await http<{ run: RunRow }>(`/v1/runs`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.run;
}

// POST /v1/runs/:id/cancel marks the run for cancellation. The agent loop
// observes this between steps and closes the row as 'aborted'. Returns the
// updated row (still 'running' — UI should poll until status flips).
export async function cancelRun(id: string): Promise<RunRow> {
  const data = await http<{ run: RunRow }>(
    `/v1/runs/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
  return data.run;
}

// ----------------------------------------------------------------------------
// Skills
// ----------------------------------------------------------------------------

export interface SkillView {
  name: string;
  description: string;
  tier: number;
  model: string;
  maxSteps: number;
  maxTokens: number;
  costCeilingCents: number | null;
  allowedTools: string[];
  contentHash: string;
}

export async function listSkills(): Promise<SkillView[]> {
  const data = await http<{ skills: SkillView[] }>(`/v1/skills`);
  return data.skills;
}

export async function getSkill(name: string): Promise<SkillView | null> {
  try {
    const data = await http<{ skill: SkillView }>(`/v1/skills/${encodeURIComponent(name)}`);
    return data.skill;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('404')) return null;
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Tenant profile + runtime override
// ----------------------------------------------------------------------------

// Mirrors @ventus/store TenantProfile. The body is the human-authored context
// block injected into every agent run's system prompt; runtime is the
// per-tenant provider/model override (null when the tenant uses the skill's
// default model).
export interface TenantRuntimeConfig {
  provider: string;
  model: string;
}

export interface TenantProfile {
  tenantId: string;
  body: string;
  contentHash: string;
  updatedAt: string;
  updatedBy?: string;
  runtime?: TenantRuntimeConfig | null;
  runtimeUpdatedAt?: string;
  runtimeUpdatedBy?: string;
}

export async function getTenantProfile(): Promise<TenantProfile | null> {
  try {
    const data = await http<{ profile: TenantProfile }>(`/v1/tenant/profile`);
    return data.profile;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('404')) return null;
    throw err;
  }
}

export async function setTenantProfile(body: string): Promise<TenantProfile> {
  const data = await http<{ profile: TenantProfile }>(`/v1/tenant/profile`, {
    method: 'PUT',
    asAdmin: true,
    body: JSON.stringify({ body }),
  });
  return data.profile;
}

export async function deleteTenantProfile(): Promise<void> {
  await http<void>(`/v1/tenant/profile`, { method: 'DELETE', asAdmin: true });
}

export async function setTenantRuntime(cfg: TenantRuntimeConfig): Promise<TenantProfile> {
  const data = await http<{ profile: TenantProfile }>(`/v1/tenant/runtime`, {
    method: 'PUT',
    asAdmin: true,
    body: JSON.stringify(cfg),
  });
  return data.profile;
}

export async function deleteTenantRuntime(): Promise<void> {
  await http<void>(`/v1/tenant/runtime`, { method: 'DELETE', asAdmin: true });
}

// ----------------------------------------------------------------------------
// Admin diagnostics — pricing coverage + runtime drift
// ----------------------------------------------------------------------------

export interface PricingCoverageEntry {
  source: 'skill' | 'tenant';
  identifier: string;
  provider: string | null;
  model: string;
  priced: boolean;
}

export interface PricingCoverageReport {
  entries: PricingCoverageEntry[];
  ok: boolean;
  unpricedCount: number;
}

export async function getPricingCoverage(): Promise<PricingCoverageReport> {
  return http<PricingCoverageReport>(`/v1/admin/pricing-coverage`, { asAdmin: true });
}

export interface RuntimeDriftEntry {
  tenantId: string;
  provider: string;
  model: string;
  runtimeUpdatedAt?: string;
  runtimeUpdatedBy?: string;
}

export interface RuntimeDriftReport {
  entries: RuntimeDriftEntry[];
  registeredProviders: string[];
}

export async function getRuntimeDrift(): Promise<RuntimeDriftReport> {
  return http<RuntimeDriftReport>(`/v1/admin/runtime-drift`, { asAdmin: true });
}
