import type { Proposal } from '@ventus/store';
import type { ExecutorContext, ProposalExecutor } from './types.js';
import { effectivePayload } from './types.js';
import { appendToOutbox } from './outbox.js';

interface SlackPayload {
  channel: string;
  text: string;
  thread_ts?: string;
}

function isSlackPayload(v: unknown): v is SlackPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.channel === 'string' && typeof p.text === 'string';
}

export class MockSlackExecutor implements ProposalExecutor {
  readonly actionType = 'draft_slack_reply';

  constructor(private readonly outboxPath: string) {}

  async execute(proposal: Proposal, ctx: ExecutorContext): Promise<unknown> {
    const payload = effectivePayload(proposal);
    if (!isSlackPayload(payload)) {
      throw new Error('slack payload must include string fields: channel, text');
    }
    const rec = await appendToOutbox(this.outboxPath, {
      channel: 'slack',
      proposalId: ctx.proposalId,
      tenantId: ctx.tenantId,
      payload,
    });
    return {
      delivery_id: rec.id,
      channel: 'slack',
      to: payload.channel,
      delivered_at: rec.deliveredAt,
      note: 'mock executor — written to local outbox, no Slack API call made',
    };
  }
}
