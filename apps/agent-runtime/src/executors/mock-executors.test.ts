import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Proposal } from '@ventus/store';
import { MockEmailExecutor } from './mock-email.js';
import { MockSlackExecutor } from './mock-slack.js';
import { effectivePayload, type ExecutorContext } from './types.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function proposal(payload: unknown, actionType = 'draft_email_reply'): Proposal {
  return {
    id: 'p1',
    tenantId: TENANT,
    runId: 'run-1',
    agentId: 'agent-1',
    actionType,
    payload,
    status: 'approved',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decision: {
      approverId: 'user-1',
      verdict: 'approved',
      decidedAt: new Date().toISOString(),
    },
  };
}

function ctx(p: Proposal, over: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    tenantId: p.tenantId,
    proposalId: p.id,
    approverId: p.decision?.approverId ?? 'user-1',
    idempotencyKey: p.id,
    ...over,
  };
}

describe('MockEmailExecutor', () => {
  let dir: string;
  let path: string;
  let exec: MockEmailExecutor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-mock-email-'));
    path = join(dir, 'outbox.json');
    exec = new MockEmailExecutor(path);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares action_type=draft_email_reply', () => {
    expect(exec.actionType).toBe('draft_email_reply');
  });

  it('writes a delivery record to the outbox on valid payload', async () => {
    const p = proposal({ to: 'a@b.com', subject: 'hello', body: 'world' });
    const result = await exec.execute(p, ctx(p));

    expect((result as { channel: string }).channel).toBe('email');
    expect((result as { to: string }).to).toBe('a@b.com');

    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries).toHaveLength(1);
    expect(file.deliveries[0].channel).toBe('email');
    expect(file.deliveries[0].tenantId).toBe(TENANT);
  });

  it('rejects payload missing required fields', async () => {
    const p = proposal({ to: 'a@b.com' });
    await expect(exec.execute(p, ctx(p))).rejects.toThrow(/email payload/);
  });

  it('rejects payload when fields are wrong types', async () => {
    const p = proposal({ to: 1, subject: 's', body: 'b' });
    await expect(exec.execute(p, ctx(p))).rejects.toThrow(/email payload/);
  });

  it('prefers decision.editedPayload over the original payload', async () => {
    const p = proposal({ to: 'original@x.com', subject: 's', body: 'b' });
    p.decision = {
      ...p.decision!,
      verdict: 'edited',
      editedPayload: { to: 'edited@x.com', subject: 's', body: 'b' },
    };

    const result = await exec.execute(p, ctx(p));

    expect((result as { to: string }).to).toBe('edited@x.com');
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries[0].payload.to).toBe('edited@x.com');
  });

  it('propagates idempotencyKey as the outbox delivery id', async () => {
    const p = proposal({ to: 'a@b.com', subject: 's', body: 'b' });
    const result = await exec.execute(p, ctx(p, { idempotencyKey: 'idem-email-1' }));
    expect((result as { delivery_id: string }).delivery_id).toBe('idem-email-1');

    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries[0].id).toBe('idem-email-1');
  });

  it('dedupes when called twice with the same idempotencyKey (at-most-once delivery)', async () => {
    // Simulates the crash-then-retry scenario: orchestrator restarts mid-execute
    // and re-issues with the same proposal.id. Side effect must commit once.
    const p = proposal({ to: 'a@b.com', subject: 's', body: 'b' });
    const c = ctx(p, { idempotencyKey: 'replay-key' });
    const first = await exec.execute(p, c);
    const second = await exec.execute(p, c);
    expect((second as { delivery_id: string }).delivery_id).toBe(
      (first as { delivery_id: string }).delivery_id,
    );
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries).toHaveLength(1);
  });
});

describe('MockSlackExecutor', () => {
  let dir: string;
  let path: string;
  let exec: MockSlackExecutor;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-mock-slack-'));
    path = join(dir, 'outbox.json');
    exec = new MockSlackExecutor(path);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declares action_type=draft_slack_reply', () => {
    expect(exec.actionType).toBe('draft_slack_reply');
  });

  it('writes a delivery record on valid payload', async () => {
    const p = proposal({ channel: '#general', text: 'hi' }, 'draft_slack_reply');
    const result = await exec.execute(p, ctx(p));

    expect((result as { channel: string }).channel).toBe('slack');
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries[0].payload.channel).toBe('#general');
  });

  it('rejects payload missing channel', async () => {
    const p = proposal({ text: 'hi' }, 'draft_slack_reply');
    await expect(exec.execute(p, ctx(p))).rejects.toThrow(/slack payload/);
  });

  it('rejects payload missing text', async () => {
    const p = proposal({ channel: '#general' }, 'draft_slack_reply');
    await expect(exec.execute(p, ctx(p))).rejects.toThrow(/slack payload/);
  });

  it('propagates idempotencyKey as the outbox delivery id', async () => {
    const p = proposal({ channel: '#general', text: 'hi' }, 'draft_slack_reply');
    await exec.execute(p, ctx(p, { idempotencyKey: 'idem-slack-1' }));
    const file = JSON.parse(await readFile(path, 'utf8'));
    expect(file.deliveries[0].id).toBe('idem-slack-1');
  });
});

describe('effectivePayload', () => {
  it('returns payload when no decision', () => {
    const p = proposal({ to: 'a@b.com' });
    delete (p as { decision?: unknown }).decision;
    expect(effectivePayload(p)).toEqual({ to: 'a@b.com' });
  });

  it('returns payload when decision has no editedPayload', () => {
    const p = proposal({ to: 'a@b.com' });
    expect(effectivePayload(p)).toEqual({ to: 'a@b.com' });
  });

  it('returns editedPayload when present', () => {
    const p = proposal({ to: 'original' });
    p.decision = { ...p.decision!, verdict: 'edited', editedPayload: { to: 'edited' } };
    expect(effectivePayload(p)).toEqual({ to: 'edited' });
  });
});
