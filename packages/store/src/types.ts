export type ProposalStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'rejected'
  | 'executed'
  | 'failed'
  | 'expired';

export interface ProposalInput {
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
  expiresAt?: string;
  // Snapshot hash of the Run that produced this proposal — copied off the
  // Run row so the proposal carries its own provenance and stays verifiable
  // even if the Run row is later mutated. Optional because tests + older
  // callers may not supply it; the live agent path always does.
  contextSnapshotHash?: string;
}

export interface Proposal extends ProposalInput {
  id: string;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  decision?: ProposalDecision;
}

export interface ProposalDecision {
  approverId: string;
  verdict: 'approved' | 'rejected' | 'edited';
  comment?: string;
  editedPayload?: unknown;
  decidedAt: string;
}

export interface ProposalStore {
  create(input: ProposalInput): Promise<Proposal>;
  get(id: string): Promise<Proposal | null>;
  list(filter?: {
    tenantId?: string;
    status?: ProposalStatus;
    runId?: string;
    limit?: number;
  }): Promise<Proposal[]>;
  decide(id: string, decision: ProposalDecision): Promise<Proposal>;
  // Atomically claims an approved proposal for execution. Returns the updated
  // proposal (status=executing) on success, or null if the proposal was not in
  // 'approved' state (already claimed, already executed, etc.). Prevents the
  // approved→read→sideEffect→read→sideEffect race that would otherwise
  // duplicate-deliver on concurrent executions.
  beginExecution(id: string): Promise<Proposal | null>;
  // Flips executing → executed. Requires status='executing' (use beginExecution first).
  markExecuted(id: string): Promise<Proposal>;
  // Flips executing → failed. The error itself lives in the audit trail —
  // the proposal only carries the status flag.
  markExecutionFailed(id: string): Promise<Proposal>;
}

// ----------------------------------------------------------------------------
// Run
// ----------------------------------------------------------------------------
//
// A Run is one execution of a Skill against a tenant. It owns the audit and
// proposal records produced during that execution. Open at start, closed at
// end. Cost and final-text are recorded so a reviewer can quickly answer
// "what did the agent do, how much did it cost, what did it produce".

export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'halted'
  | 'aborted';

export interface RunInput {
  tenantId: string;
  agentId: string;
  skillId?: string;
  model?: string;
  userMessage?: string;
  // Provenance — pins the exact skill bytes that ran (so a later edit to the
  // on-disk SKILL.md doesn't silently rewrite history) and the canonicalized
  // hash of the effective per-run context (skill hash + model + resolved
  // tool list + max_steps/tokens + cost ceiling + user message hash).
  // Both are optional on the input so test fixtures + legacy callers don't
  // break; the live API path (startRunAgent) always sets them.
  skillContentHash?: string;
  contextSnapshotHash?: string;
  // Provenance for the injected tenant_profile. null when the tenant had no
  // profile at run time, undefined when this caller doesn't track profiles
  // at all (CLI, legacy tests). Persisted on the row so an auditor can tell
  // which profile snapshot each run actually saw.
  tenantProfileHash?: string | null;
}

export interface RunRecord extends RunInput {
  id: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  totalCostMicros?: number;
  proposalCount?: number;
  finalText?: string;
  haltReason?: string;
  errorText?: string;
  // When a caller asked the run to stop. Persisted on the row so a restarted
  // worker / future poll picks it up. The agent loop reads this between steps
  // via killSwitchCheck and exits with status='aborted'. The field stays set
  // after termination as a record of the cancel request.
  cancelRequestedAt?: string;
  cancelRequestedBy?: string;
  // Liveness signal written by the agent loop between steps. The reaper
  // worker (apps/worker) closes any 'running' row whose lastHeartbeatAt is
  // older than the stale threshold as 'failed' with errorText='no heartbeat'.
  // Distinguishes "loop still working" from "process died mid-step" — the
  // in-process try/finally already handles vendor SDK throws, but it can't
  // help a SIGKILL/OOM/hardware-pull. Undefined on legacy rows or in-process
  // runs that completed before the field existed.
  lastHeartbeatAt?: string;
}

export interface RunCompletion {
  status: 'completed' | 'failed' | 'halted' | 'aborted';
  totalCostMicros?: number;
  proposalCount?: number;
  finalText?: string;
  haltReason?: string;
  errorText?: string;
}

export interface RunStore {
  create(input: RunInput): Promise<RunRecord>;
  get(id: string): Promise<RunRecord | null>;
  list(filter?: {
    tenantId?: string;
    status?: RunStatus;
    agentId?: string;
    limit?: number;
  }): Promise<RunRecord[]>;
  // Closes a run with its final status + accounting. Requires status='running'.
  complete(id: string, completion: RunCompletion): Promise<RunRecord>;
  // Marks the run for cancellation. The agent loop polls this between steps
  // and exits with status='aborted'. Returns the updated row, or null if the
  // run was not found. Idempotent — calling on an already-cancelled or
  // already-terminal row returns the existing row unchanged.
  requestCancel(
    id: string,
    by: { requestedBy: string; at?: string },
  ): Promise<RunRecord | null>;
  // Writes a fresh lastHeartbeatAt on a 'running' row. No-op (returns the
  // existing row, no error) on terminal rows — the agent loop may race the
  // reaper writing 'failed', and we don't want a write-after-close to throw
  // and pollute logs. Returns null if the row doesn't exist.
  heartbeat(id: string, at?: string): Promise<RunRecord | null>;
  // Atomically closes a 'running' row as 'failed' IF the row's effective
  // liveness timestamp (lastHeartbeatAt ?? startedAt) is still older than
  // `staleAsOf` at the moment of the write. The reaper uses this instead of
  // a plain complete() so a heartbeat queued behind the writeLock can save
  // a live run: if heartbeat lands first, lastHeartbeatAt > staleAsOf and
  // we return null (no kill). Returns the reaped row on success, null if
  // the run is no longer eligible (heartbeat refreshed, status already
  // terminal, or row missing).
  reapIfStale(
    id: string,
    opts: { staleAsOf: string; completion: RunCompletion },
  ): Promise<RunRecord | null>;
}

// ----------------------------------------------------------------------------
// Audit
// ----------------------------------------------------------------------------

export interface AuditIntentRecord {
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
  // Same provenance as ProposalInput.contextSnapshotHash — copied off the
  // Run so each intent is independently verifiable against the prompt that
  // produced it. Optional for the same reason (user/system intents may not
  // have an originating agent context).
  contextSnapshotHash?: string;
}

export interface AuditOutcomeRecord {
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

// Joined view: every intent paired with its matching outcome (or null when
// the outcome write itself failed — those are visible as "orphaned" rows so
// reconciliation can surface them).
export interface AuditTrailRow {
  intent: AuditIntentRecord;
  outcome: AuditOutcomeRecord | null;
}

export interface AuditTrailFilter {
  tenantId: string;
  resourceType?: string;
  resourceId?: string;
  runId?: string;
  limit?: number;
}

export interface AuditStore {
  recordIntent(record: Omit<AuditIntentRecord, 'id' | 'proposedAt'>): Promise<AuditIntentRecord>;
  recordOutcome(
    record: Omit<AuditOutcomeRecord, 'id' | 'recordedAt'>,
  ): Promise<AuditOutcomeRecord>;
  listIntents(tenantId: string): Promise<AuditIntentRecord[]>;
  listOutcomes(tenantId: string): Promise<AuditOutcomeRecord[]>;
  listAuditTrail(filter: AuditTrailFilter): Promise<AuditTrailRow[]>;
}

// ----------------------------------------------------------------------------
// TenantProfile — bounded, read-only-at-runtime system prompt context
// ----------------------------------------------------------------------------
//
// Stable per-tenant facts the agent should always see: company name, brand
// voice, industry, house rules. Set by an admin (manually or via ETL), NEVER
// by the agent itself. Injected ONCE at the top of the system prompt for
// every run in that tenant, with a hash folded into the Run's
// contextSnapshotHash so two runs with different profile snapshots are
// recognisably distinct.
//
// Why bounded: lets us reason about token cost ("at most N tokens per run")
// and prevents the profile from drifting into an unstructured "agent memory"
// the model is conditioned on. Cap chosen to match the Hermes pattern's
// ~3.5K char working-memory budget; tune in MAX_TENANT_PROFILE_LEN below.
//
// Why read-only at runtime: the agent has no tool to mutate the profile, so
// its declared behavior stays inspectable. Future writable memory will be
// a SEPARATE concept with its own audit trail.

// Hard cap on profile body length. Enforced by stores on write. Roughly
// 3-4K tokens at typical English density — large enough for a tenant
// description + brand rules, small enough that we can quote it in audit
// reports and never have it dominate the prompt budget.
export const MAX_TENANT_PROFILE_LEN = 4_000;

export interface TenantProfile {
  tenantId: string;
  // Free-form markdown the agent will see verbatim at the top of its system
  // prompt. Trimmed of leading/trailing whitespace on write.
  body: string;
  // SHA-256 (hex) of the body bytes. Recomputed on every write so callers
  // never need to hash the body themselves. Folded into Run contextSnapshotHash.
  contentHash: string;
  // ISO timestamp of the most recent write.
  updatedAt: string;
  // User id of the most recent writer (header-derived for now — see the
  // auth TODO in apps/web/src/lib/api.ts).
  updatedBy?: string;
}

export interface TenantProfileStore {
  get(tenantId: string): Promise<TenantProfile | null>;
  // Replaces the tenant's profile in full. Throws if body exceeds
  // MAX_TENANT_PROFILE_LEN. Pass body='' to clear.
  set(
    tenantId: string,
    body: string,
    by: { updatedBy?: string; at?: string },
  ): Promise<TenantProfile>;
}
