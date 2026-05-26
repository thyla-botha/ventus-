import type { Proposal } from '@ventus/store';
import type { ExecutorContext, ProposalExecutor } from './types.js';
import { effectivePayload } from './types.js';
import { appendToOutbox } from './outbox.js';

interface EmailPayload {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}

function isEmailPayload(v: unknown): v is EmailPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.to === 'string' && typeof p.subject === 'string' && typeof p.body === 'string';
}

export class MockEmailExecutor implements ProposalExecutor {
  readonly actionType = 'draft_email_reply';

  constructor(private readonly outboxPath: string) {}

  async execute(proposal: Proposal, ctx: ExecutorContext): Promise<unknown> {
    const payload = effectivePayload(proposal);
    if (!isEmailPayload(payload)) {
      throw new Error('email payload must include string fields: to, subject, body');
    }
    const rec = await appendToOutbox(this.outboxPath, {
      channel: 'email',
      proposalId: ctx.proposalId,
      tenantId: ctx.tenantId,
      payload,
    });
    return {
      delivery_id: rec.id,
      channel: 'email',
      to: payload.to,
      delivered_at: rec.deliveredAt,
      note: 'mock executor — written to local outbox, no SMTP call made',
    };
  }
}
