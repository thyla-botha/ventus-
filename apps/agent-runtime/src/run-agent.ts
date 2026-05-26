import { hashPayload } from '@ventus/audit';
import type { Skill } from '@ventus/skills';
import type {
  AuditStore,
  ProposalStore,
  RunRecord,
  RunStore,
  TenantProfile,
  TenantProfileStore,
} from '@ventus/store';
import { auditedExecutor } from './audited-executor.js';
import { MOCK_TOOLS, mockToolExecutor } from './mock-tools.js';
import { CREATE_PROPOSAL_TOOL, withProposalTool } from './proposal-tool.js';
import { RunTracker } from './run-tracker.js';
import type { AgentRuntime, RunStepEvent, ToolDefinition, ToolExecutor } from './runtime.js';

// Orchestrates one agent run against a Skill. Owns the lifecycle invariants:
//   1. A Run row is opened BEFORE the loop and ALWAYS closed afterwards.
//   2. Tool calls are routed through withProposalTool (for create_proposal)
//      and wrapped by auditedExecutor (two-phase intent/outcome).
//   3. If the runtime throws mid-stream, the error is captured into the Run
//      row as a 'failed' completion, then re-thrown so callers see it.
//
// Two entry points:
//   - runAgent(deps, params): synchronously drives the whole loop and resolves
//     once the Run row is closed. Used by the CLI.
//   - startRunAgent(deps, params): opens the Run row, returns immediately,
//     completes the loop in the background. Used by the API so an HTTP
//     handler can return the runId without waiting for Anthropic.

export interface RunAgentDeps {
  proposals: ProposalStore;
  audit: AuditStore;
  runs: RunStore;
  runtime: AgentRuntime;
  // Optional. When provided, the run pulls the tenant's profile and injects it
  // at the top of the effective system prompt. Omit (or pass null) in tests
  // and the CLI to opt out — runs then behave exactly as they did pre-profile.
  tenantProfiles?: TenantProfileStore;
}

export interface RunAgentParams {
  skill: Skill;
  tenantId: string;
  agentId: string;
  userMessage: string;
  // Override the skill's declared model. Useful for "cheap mode" in dev.
  modelOverride?: string;
  // Called once per RunStepEvent. Receiver MUST NOT throw — exceptions are
  // suppressed (logged to console.error) so they cannot disrupt the run.
  onEvent?: (event: RunStepEvent) => void;
}

export interface RunAgentResult {
  runId: string;
  status: 'completed' | 'failed' | 'halted' | 'aborted';
  proposalCount: number;
  totalCostMicros: number;
  unknownTools: string[];
}

export interface RunAgentHandle {
  // The Run row, freshly opened (status='running'). Safe to return to an
  // HTTP caller before the loop has finished.
  run: RunRecord;
  // Resolves when the loop has closed the Run row. Rejects only if the
  // runtime threw AND the close write itself failed — the normal "loop
  // errored" path resolves with status='failed' and a fulfilled promise.
  completion: Promise<RunAgentResult>;
}

// Opens the Run row, then resolves with a handle whose `completion` resolves
// once the loop closes the row. Callers that want a synchronous "drive to
// completion" call should use runAgent() — it just awaits the handle.
export async function startRunAgent(
  deps: RunAgentDeps,
  params: RunAgentParams,
): Promise<RunAgentHandle> {
  const model = params.modelOverride ?? params.skill.model;
  const resolved = resolveRunPlan(params.skill);
  // Fetch the tenant profile (if a store is wired) BEFORE opening the row so
  // its hash can be folded into the snapshot and persisted on the row in one
  // shot. Failure to read the store is fatal here — we'd rather refuse to
  // open the run than open it against a non-deterministic prompt.
  const profile = deps.tenantProfiles
    ? await deps.tenantProfiles.get(params.tenantId)
    : null;
  const tenantProfileHash = profile?.contentHash ?? null;
  // Provenance: pin the exact skill bytes + the canonicalised effective
  // context for this run BEFORE opening the row, so the row is born with
  // its lineage. driveRun() reuses `resolved` so the tool list / context
  // hash the loop actually executes against is identical to what was
  // recorded on the row.
  const contextSnapshotHash = computeContextSnapshotHash({
    runtimeProvider: deps.runtime.provider,
    skillContentHash: params.skill.contentHash,
    model,
    toolManifest: resolved.toolManifest,
    maxSteps: params.skill.maxSteps,
    maxTokens: params.skill.maxTokens,
    costCeilingMicros: resolved.costCeilingMicros,
    userMessageHash: hashPayload(params.userMessage),
    tenantProfileHash,
  });
  const run = await deps.runs.create({
    tenantId: params.tenantId,
    agentId: params.agentId,
    skillId: params.skill.name,
    model,
    userMessage: params.userMessage,
    skillContentHash: params.skill.contentHash,
    contextSnapshotHash,
    tenantProfileHash,
  });
  const completion = driveRun(deps, run, params, resolved, profile);
  return { run, completion };
}

interface ResolvedRunPlan {
  tools: ToolDefinition[];
  // Full tool manifest the runtime will send to the vendor, sorted by name
  // and reduced to the fields the model actually sees: name + description +
  // inputSchema. Hashed into contextSnapshotHash so a change to a tool's
  // description or schema invalidates the snapshot — which is the whole
  // point: the agent "saw" something different.
  toolManifest: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  unknownTools: string[];
  wantsProposal: boolean;
  costCeilingMicros: number | undefined;
}

// Pure derivation of the runtime-facing plan from the skill. Pulled out so
// startRunAgent can hash the resolved tool list BEFORE opening the Run row
// AND driveRun can use the exact same plan when actually invoking the
// runtime — guarantees the provenance hash matches what the loop ran.
function resolveRunPlan(skill: Skill): ResolvedRunPlan {
  const wantsProposal = skill.allowedTools.includes(CREATE_PROPOSAL_TOOL.name);
  const tools: ToolDefinition[] = MOCK_TOOLS.filter((t) => skill.allowedTools.includes(t.name));
  if (wantsProposal) tools.push(CREATE_PROPOSAL_TOOL);
  const knownToolNames = new Set<string>([
    ...MOCK_TOOLS.map((t) => t.name),
    CREATE_PROPOSAL_TOOL.name,
  ]);
  const unknownTools = skill.allowedTools.filter((n) => !knownToolNames.has(n));
  const toolManifest = tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const costCeilingMicros =
    skill.costCeilingCents !== null ? skill.costCeilingCents * 10_000 : undefined;
  return { tools, toolManifest, unknownTools, wantsProposal, costCeilingMicros };
}

// Hash of the inputs that uniquely determine what the agent saw — runtime
// provider, skill bytes, model, resolved tool MANIFEST (full descriptions +
// schemas, not just names), step/token caps, cost ceiling, and the user
// message hash. Two runs of the SAME skill with the SAME user message get
// the SAME snapshot hash even across restarts. Two runs that differ in any
// of these fields get different hashes.
//
// We hash the user message rather than embed it so the snapshot stays
// small/log-friendly but is still reproducible from the Run row (which
// stores the raw userMessage). systemPrompt is not hashed separately
// because it's already inside skillContentHash.
//
// Versioned via `schema` so a future change to what we hash (e.g. adding
// temperature) cleanly invalidates old hashes rather than silently shifting
// the meaning of an existing one.
function computeContextSnapshotHash(parts: {
  runtimeProvider: string;
  skillContentHash: string;
  model: string;
  toolManifest: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  maxSteps: number;
  maxTokens: number;
  costCeilingMicros: number | undefined;
  userMessageHash: string;
  // Hash of the tenant_profile body bytes when one was injected, null when
  // the tenant had no profile. Folded in so two runs with otherwise identical
  // inputs but different tenant context produce different snapshots — and so
  // a later edit to the profile invalidates the snapshot for new runs.
  tenantProfileHash: string | null;
}): string {
  return hashPayload({
    schema: 'ventus.run.context.v3',
    runtimeProvider: parts.runtimeProvider,
    skillContentHash: parts.skillContentHash,
    model: parts.model,
    toolManifest: parts.toolManifest,
    maxSteps: parts.maxSteps,
    maxTokens: parts.maxTokens,
    costCeilingMicros: parts.costCeilingMicros ?? null,
    userMessageHash: parts.userMessageHash,
    tenantProfileHash: parts.tenantProfileHash,
  });
}

// Composes the effective system prompt the runtime will see for this run.
// When a tenant profile is present, it sits inside a <tenant_context> block
// at the TOP of the prompt — above the skill body — so the skill's own
// instructions stay the last thing the model reads. The marker tags make
// the boundary unambiguous for both the model and a human auditor reading
// the trace; empty profiles still get the block (the empty body's hash is
// part of the snapshot, so we keep the prompt shape consistent).
//
// Prompt-injection threat model (accepted risk):
// The <tenant_context> wrapper is plain text — model providers do not treat
// XML tags as security boundaries. An attacker who can write the profile
// body could embed `</tenant_context><system>ignore prior</system>` and
// attempt to escape into pseudo-system instructions. We accept this risk
// because PUT/DELETE /v1/tenant/profile is gated by the requireAdmin guard
// in apps/api/src/middleware/tenant.ts — so the writer of the profile is by
// definition trusted-with-prompt (equivalent to editing a SKILL.md file).
// If we ever expose profile writes to non-admin tenant members, this
// composition MUST be revisited: either move the profile into a user-role
// turn-0 message, escape angle brackets, or whitelist a markdown subset.
function composeSystemPrompt(skill: Skill, profile: TenantProfile | null): string {
  if (!profile) return skill.systemPrompt;
  return `<tenant_context>\n${profile.body}\n</tenant_context>\n\n${skill.systemPrompt}`;
}

// Drives one Run to completion. Resolves once the Run row is closed.
export async function runAgent(
  deps: RunAgentDeps,
  params: RunAgentParams,
): Promise<RunAgentResult> {
  const handle = await startRunAgent(deps, params);
  return handle.completion;
}

async function driveRun(
  deps: RunAgentDeps,
  run: RunRecord,
  params: RunAgentParams,
  resolved: ResolvedRunPlan,
  profile: TenantProfile | null,
): Promise<RunAgentResult> {
  const { skill, tenantId, agentId, userMessage } = params;
  const model = run.model ?? params.modelOverride ?? skill.model;
  const runId = run.id;
  // Same profile we hashed into the snapshot — passing it through guarantees
  // the bytes the model sees match the bytes we attested to on the row.
  const systemPrompt = composeSystemPrompt(skill, profile);

  const { tools, unknownTools, wantsProposal, costCeilingMicros } = resolved;
  // Pulled off the Run row (not re-derived) so a future swap to a real DB
  // where the row is the source of truth Just Works — and so that proposals
  // and audit intents carry the exact hash that's persisted on the run.
  const contextSnapshotHash = run.contextSnapshotHash;

  let executor: ToolExecutor = mockToolExecutor;
  if (wantsProposal) {
    executor = withProposalTool(executor, {
      proposals: deps.proposals,
      tenantId,
      runId,
      agentId,
      contextSnapshotHash,
    });
  }
  executor = auditedExecutor(executor, {
    audit: deps.audit,
    tenantId,
    runId,
    agentId,
    contextSnapshotHash,
  });

  const tracker = new RunTracker();
  let lastEvent = '';
  let iterationError: unknown;
  // Set true the first time killSwitchCheck observes cancelRequestedAt on the
  // store row. Used at the bottom of this function to map the runtime's
  // emitted 'halted' (reason=kill_switch_tripped) into a user-facing
  // status='aborted' — we want explicit user cancellation to read distinctly
  // from "agent halted itself" (e.g. cost ceiling) on the Run row.
  let userCancelObserved = false;

  // Polls the Run row between steps. Memoises the cancel observation so a
  // single store hit suffices once the flag is set. We deliberately fail-open
  // on store read errors (treat as "no cancel signal") so a transient blip
  // doesn't take down a healthy loop — but we ALWAYS log with the run id so a
  // persistent store outage that's silently swallowing cancel intent is
  // visible in ops. Codex flagged: silent swallow + no audit was a real gap
  // for a control-plane safety feature.
  const killSwitchCheck = async (): Promise<boolean> => {
    if (userCancelObserved) return true;
    try {
      const row = await deps.runs.get(runId);
      if (row?.cancelRequestedAt) {
        userCancelObserved = true;
        return true;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `killSwitchCheck: store read failed for run ${runId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return false;
  };

  try {
    for await (const event of deps.runtime.run({
      tenantId,
      runId,
      agentId,
      model,
      systemPrompt,
      userMessage,
      tools,
      toolExecutor: executor,
      maxSteps: skill.maxSteps,
      maxTokens: skill.maxTokens,
      costCeilingMicros,
      killSwitchCheck,
    })) {
      lastEvent = event.type;
      // Liveness signal: every step the loop opens, refresh lastHeartbeatAt
      // on the Run row. The reaper (apps/worker) closes any 'running' row
      // whose heartbeat is older than its stale threshold. Fire-and-forget
      // because: (a) the heartbeat is best-effort — a transient store blip
      // shouldn't kill a healthy loop, and (b) awaiting would serialise the
      // loop behind the file-store's writeLock, which is acceptable here but
      // adds nothing for the common-case "store is healthy". Errors are
      // logged so a persistent outage is visible.
      //
      // Safety against the heartbeat/reaper race (codex HIGH-3): the reaper
      // calls runs.reapIfStale(), which re-checks lastHeartbeatAt under the
      // store's writeLock. If THIS fire-and-forget write is queued behind
      // the reaper but lands first, the reaper's re-check sees the fresh
      // timestamp and bails. So fire-and-forget is safe even under heavy
      // store contention.
      if (event.type === 'step_started') {
        deps.runs.heartbeat(runId).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(
            `heartbeat: store write failed for run ${runId}:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
      tracker.observe(event);
      if (params.onEvent) {
        try {
          params.onEvent(event);
        } catch (cbErr) {
          // Never let a caller's onEvent callback take down the run.
          // eslint-disable-next-line no-console
          console.error('runAgent: onEvent callback threw', cbErr);
        }
      }
    }
  } catch (err) {
    iterationError = err;
  }

  if (iterationError && !tracker.hasTerminal()) {
    tracker.observe({
      type: 'error',
      error: iterationError instanceof Error ? iterationError.message : String(iterationError),
    });
  }

  const rawCompletion = tracker.finalize({ lastEvent });
  // The runtime can't tell user-cancel from cost-ceiling-halt — both emit
  // 'halted'. We can: if userCancelObserved is set, transform the halt into
  // an 'aborted' close so the Run row + UI distinguish them clearly.
  const completion =
    userCancelObserved && rawCompletion.status === 'halted'
      ? { ...rawCompletion, status: 'aborted' as const }
      : rawCompletion;
  // Reaper-vs-loop race: the reaper may have closed this row as 'failed' /
  // 'no heartbeat' while we were finalising. complete() throws when the row
  // is no longer 'running'. Treat that as benign — the reaper's verdict is
  // the truth (we evidently weren't writing heartbeats fast enough) and the
  // row is already terminal, so we just return its current state.
  let closed: RunRecord;
  try {
    closed = await deps.runs.complete(runId, completion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/not running/.test(msg)) throw err;
    const existing = await deps.runs.get(runId);
    if (!existing) throw err;
    // eslint-disable-next-line no-console
    console.log(
      `runAgent: race with reaper on run ${runId} — adopting reaper's close (status=${existing.status})`,
    );
    closed = existing;
  }

  // Resolve normally even on error — the failure is recorded on the Run row.
  // (The synchronous runAgent() entry point still surfaces this via the row.)
  return {
    runId,
    status: closed.status as 'completed' | 'failed' | 'halted' | 'aborted',
    proposalCount: closed.proposalCount ?? 0,
    totalCostMicros: closed.totalCostMicros ?? 0,
    unknownTools,
  };
}
