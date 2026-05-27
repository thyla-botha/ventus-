import type { Proposal } from '@ventus/store';

// A ProposalExecutor turns an approved proposal into a real-world side effect:
// sending an email, posting to Slack, creating a Jira ticket. One executor per
// action_type. Local executors write to JSON "outbox" files; production
// executors will hit external APIs via the MCP gateway.
//
// The executor receives the full Proposal (after human approval — including
// any edits the reviewer made to the payload via decision.editedPayload). It
// returns a free-form result the audit log captures verbatim, or throws.

export interface ExecutorContext {
  tenantId: string;
  proposalId: string;
  approverId: string;
  // Stable, deterministic key for at-most-once delivery on the executor's
  // downstream side effect. Today it's `proposal.id`; the executeProposal
  // orchestrator wires it in. Pass it through to whatever downstream call
  // supports idempotency (SendGrid X-Idempotency-Key, Twilio, Slack thread
  // dedupe, etc.) AND to local sinks (outbox row id, see appendToOutbox).
  //
  // Why this exists even though beginExecution already gates duplicates:
  // beginExecution prevents two concurrent in-process executes from running.
  // It does NOT cover (a) a process crash mid-execute where ops manually
  // resets status back to 'approved' for retry, or (b) a future Postgres
  // adapter where the state-machine compare-and-set happens across nodes.
  // A stable key makes those retries safe at the side-effect layer.
  idempotencyKey: string;
}

export interface ProposalExecutor {
  readonly actionType: string;
  execute(proposal: Proposal, ctx: ExecutorContext): Promise<unknown>;
}

export class ExecutorRegistry {
  private readonly map = new Map<string, ProposalExecutor>();

  register(executor: ProposalExecutor): this {
    if (this.map.has(executor.actionType)) {
      throw new Error(`executor already registered for ${executor.actionType}`);
    }
    this.map.set(executor.actionType, executor);
    return this;
  }

  get(actionType: string): ProposalExecutor | undefined {
    return this.map.get(actionType);
  }

  has(actionType: string): boolean {
    return this.map.has(actionType);
  }

  list(): string[] {
    return Array.from(this.map.keys()).sort();
  }
}

// Returns the payload the executor should act on: a reviewer-edited payload
// takes precedence over the agent's original draft.
export function effectivePayload(proposal: Proposal): unknown {
  const edited = proposal.decision?.editedPayload;
  return edited !== undefined ? edited : proposal.payload;
}
