import type { ProposalStore } from '@ventus/store';
import type { ToolDefinition, ToolExecutor } from './runtime.js';

// Tool that lets a Tier 2+ Skill register a draft action for human approval.
// The agent never sends/executes the action directly — it writes a Proposal
// row that surfaces in the approval inbox. Once a human approves, a separate
// executor (out of band of the agent run) performs the action.

export const CREATE_PROPOSAL_TOOL: ToolDefinition = {
  name: 'create_proposal',
  description:
    'Stage an action for human approval. The action will NOT execute until ' +
    'a human reviews and approves it. Use this for any outbound message, ' +
    'ticket comment, or state change. Returns { proposal_id, status }.',
  inputSchema: {
    type: 'object',
    properties: {
      action_type: {
        type: 'string',
        description:
          'Stable identifier of the action class. Examples: ' +
          '"draft_email_reply", "draft_slack_reply", "create_jira_ticket", ' +
          '"reassign_ticket".',
      },
      resource_type: {
        type: 'string',
        description: 'Optional resource type the action targets (e.g. "email", "ticket").',
      },
      resource_id: {
        type: 'string',
        description: 'Optional ID of the resource this action targets.',
      },
      payload: {
        type: 'object',
        description:
          'The full action payload, in the shape the executor expects. For an ' +
          'email draft: { to, subject, body }. For a ticket: { project, summary, body }.',
        additionalProperties: true,
      },
      evidence: {
        type: 'array',
        description:
          'Sources you used to construct this draft. Each item must include a ' +
          'document_id (or other citation) and a brief quote/rationale.',
        items: {
          type: 'object',
          properties: {
            document_id: { type: 'string' },
            quote: { type: 'string' },
            rationale: { type: 'string' },
          },
        },
      },
      expected_outcome: {
        type: 'string',
        description:
          'One-sentence statement of what should happen if this action is executed.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Your self-rated confidence (0-1) that this draft is correct.',
      },
    },
    required: ['action_type', 'payload'],
    additionalProperties: false,
  },
};

interface ProposalToolDeps {
  proposals: ProposalStore;
  tenantId: string;
  runId: string;
  agentId: string;
  // Optional — when set, every proposal created by this executor is stamped
  // with the originating run's context snapshot hash so reviewers can verify
  // which exact prompt produced the draft (and tie it back to the Run row).
  contextSnapshotHash?: string;
}

interface ProposalToolInput {
  action_type: string;
  resource_type?: string;
  resource_id?: string;
  payload: unknown;
  evidence?: unknown[];
  expected_outcome?: string;
  confidence?: number;
}

export function makeProposalToolExecutor(deps: ProposalToolDeps): ToolExecutor {
  return async (name, input) => {
    if (name !== CREATE_PROPOSAL_TOOL.name) {
      throw new Error(`proposal executor invoked for non-proposal tool: ${name}`);
    }
    const args = input as ProposalToolInput;
    if (!args.action_type) throw new Error('action_type is required');
    if (!args.payload) throw new Error('payload is required');

    const proposal = await deps.proposals.create({
      tenantId: deps.tenantId,
      runId: deps.runId,
      agentId: deps.agentId,
      actionType: args.action_type,
      resourceType: args.resource_type,
      resourceId: args.resource_id,
      payload: args.payload,
      evidence: args.evidence,
      expectedOutcome: args.expected_outcome,
      confidence: args.confidence,
      contextSnapshotHash: deps.contextSnapshotHash,
    });

    return {
      proposal_id: proposal.id,
      status: proposal.status,
      created_at: proposal.createdAt,
      note:
        'Draft staged for human approval. The action has NOT been executed. ' +
        'A reviewer will see this in the approval inbox.',
    };
  };
}

// Composes a base ToolExecutor with the proposal tool — if the agent calls
// create_proposal, it goes to the proposal handler; otherwise it falls through
// to the base executor.
export function withProposalTool(
  base: ToolExecutor,
  deps: ProposalToolDeps,
): ToolExecutor {
  const proposalExec = makeProposalToolExecutor(deps);
  return async (name, input, ctx) => {
    if (name === CREATE_PROPOSAL_TOOL.name) {
      return proposalExec(name, input, ctx);
    }
    return base(name, input, ctx);
  };
}
