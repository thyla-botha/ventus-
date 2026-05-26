import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuditStore } from '@ventus/store';
import { auditedExecutor } from './audited-executor.js';
import type { ToolContext, ToolExecutor } from './runtime.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const RUN = 'run-1';
const AGENT = 'agent-1';

function ctx(stepNo = 1): ToolContext {
  return { tenantId: TENANT, runId: RUN, stepNo };
}

describe('auditedExecutor', () => {
  let dir: string;
  let audit: FileAuditStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-audited-executor-'));
    audit = new FileAuditStore(join(dir, 'audit.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes an intent before the base executor runs', async () => {
    let intentsAtCallTime = -1;
    const base: ToolExecutor = async () => {
      intentsAtCallTime = (await audit.listIntents(TENANT)).length;
      return { ok: true };
    };
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });
    await wrapped('send_email', { to: 'a@b.com' }, ctx());
    expect(intentsAtCallTime).toBe(1);
  });

  it('records an executed outcome on success, paired by intentId', async () => {
    const base: ToolExecutor = async () => ({ delivered: true });
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });
    const result = await wrapped('send_email', { to: 'a@b.com' }, ctx());

    expect(result).toEqual({ delivered: true });
    const intents = await audit.listIntents(TENANT);
    const outcomes = await audit.listOutcomes(TENANT);
    expect(intents).toHaveLength(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.intentId).toBe(intents[0]!.id);
    expect(outcomes[0]!.status).toBe('executed');
    expect(outcomes[0]!.result).toEqual({ delivered: true });
    expect(outcomes[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failed outcome and rethrows when base throws', async () => {
    const base: ToolExecutor = async () => {
      throw new Error('SMTP down');
    };
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });

    await expect(wrapped('send_email', { to: 'a@b.com' }, ctx())).rejects.toThrow('SMTP down');

    const outcomes = await audit.listOutcomes(TENANT);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe('failed');
    expect(outcomes[0]!.errorText).toBe('SMTP down');
  });

  it('populates intent with actor=agent, tool name, payload hash, and stepNo', async () => {
    const base: ToolExecutor = async () => ({});
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });
    await wrapped('send_email', { to: 'x@y.com' }, ctx(7));

    const intents = await audit.listIntents(TENANT);
    const intent = intents[0]!;
    expect(intent.actorType).toBe('agent');
    expect(intent.actorId).toBe(AGENT);
    expect(intent.runId).toBe(RUN);
    expect(intent.stepNo).toBe(7);
    expect(intent.action).toBe('tool:send_email');
    expect(intent.toolName).toBe('send_email');
    expect(intent.payload).toEqual({ to: 'x@y.com' });
    expect(intent.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes payload canonically — same content in different key order → same hash', async () => {
    const base: ToolExecutor = async () => ({});
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });

    await wrapped('tool', { a: 1, b: 2 }, ctx(1));
    await wrapped('tool', { b: 2, a: 1 }, ctx(2));

    const intents = await audit.listIntents(TENANT);
    expect(intents).toHaveLength(2);
    expect(intents[0]!.payloadHash).toBe(intents[1]!.payloadHash);
  });

  it('produces different hashes for different content', async () => {
    const base: ToolExecutor = async () => ({});
    const wrapped = auditedExecutor(base, { audit, tenantId: TENANT, runId: RUN, agentId: AGENT });

    await wrapped('tool', { a: 1 }, ctx(1));
    await wrapped('tool', { a: 2 }, ctx(2));

    const intents = await audit.listIntents(TENANT);
    expect(intents[0]!.payloadHash).not.toBe(intents[1]!.payloadHash);
  });

  it('orphan: intent persists even if outcome write throws (and original error rethrows)', async () => {
    const base: ToolExecutor = async () => {
      throw new Error('inner failure');
    };
    // Replace recordOutcome to simulate a downstream audit-write failure.
    // Intents still flow to the real store; outcomes throw.
    const broken: FileAuditStore = Object.create(audit);
    Object.defineProperty(broken, 'recordOutcome', {
      value: async () => {
        throw new Error('audit unavailable');
      },
    });
    const wrapped = auditedExecutor(base, {
      audit: broken,
      tenantId: TENANT,
      runId: RUN,
      agentId: AGENT,
    });

    await expect(wrapped('send_email', { to: 'a@b.com' }, ctx())).rejects.toThrow('inner failure');

    // Intent persisted on the real store; no outcome row exists → orphan.
    const trail = await audit.listAuditTrail({ tenantId: TENANT });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.outcome).toBeNull();
  });
});
