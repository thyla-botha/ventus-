import { MockEmailExecutor } from './mock-email.js';
import { MockSlackExecutor } from './mock-slack.js';
import { ExecutorRegistry } from './types.js';

export type { ProposalExecutor, ExecutorContext } from './types.js';
export { ExecutorRegistry, effectivePayload } from './types.js';
export type { ExecuteDeps, ExecuteResult } from './execute.js';
export { executeProposal, executeAllApproved } from './execute.js';
export { MockEmailExecutor } from './mock-email.js';
export { MockSlackExecutor } from './mock-slack.js';
export type { OutboxRecord } from './outbox.js';
export { appendToOutbox } from './outbox.js';

// Default local registry: mock executors for the two action_types our Tier 2
// Skills currently emit. Production code will swap these for real SMTP /
// Slack-API-backed executors, but the interface stays the same.
export function buildLocalRegistry(outboxPath: string): ExecutorRegistry {
  return new ExecutorRegistry()
    .register(new MockEmailExecutor(outboxPath))
    .register(new MockSlackExecutor(outboxPath));
}
