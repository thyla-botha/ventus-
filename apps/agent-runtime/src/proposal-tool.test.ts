import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileProposalStore } from '@ventus/store';
import {
  CREATE_PROPOSAL_TOOL,
  makeProposalToolExecutor,
  withProposalTool,
} from './proposal-tool.js';
import type { ToolContext, ToolExecutor } from './runtime.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const RUN_ID = 'run-1';
const AGENT_ID = 'agent-1';

const ctx: ToolContext = { tenantId: TENANT, runId: RUN_ID, stepNo: 1 };

describe('CREATE_PROPOSAL_TOOL definition', () => {
  it('has a stable name', () => {
    expect(CREATE_PROPOSAL_TOOL.name).toBe('create_proposal');
  });

  it('requires action_type and payload in the schema', () => {
    expect(CREATE_PROPOSAL_TOOL.inputSchema.required).toEqual([
      'action_type',
      'payload',
    ]);
  });

  it('forbids additionalProperties at the top level', () => {
    expect(CREATE_PROPOSAL_TOOL.inputSchema.additionalProperties).toBe(false);
  });
});

describe('makeProposalToolExecutor', () => {
  let dir: string;
  let proposals: FileProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-proposal-tool-'));
    proposals = new FileProposalStore(join(dir, 'proposals.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a pending proposal and returns id + status + note', async () => {
    const exec = makeProposalToolExecutor({
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    const result = (await exec(
      'create_proposal',
      {
        action_type: 'draft_email_reply',
        payload: { to: 'a@b.com', subject: 's', body: 'b' },
        evidence: [{ document_id: 'doc-1', quote: 'q', rationale: 'r' }],
        expected_outcome: 'reply sent',
        confidence: 0.8,
      },
      ctx,
    )) as { proposal_id: string; status: string; note: string };

    expect(result.proposal_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.status).toBe('pending');
    expect(result.note).toMatch(/has NOT been executed/);

    const persisted = await proposals.get(result.proposal_id);
    expect(persisted?.status).toBe('pending');
    expect(persisted?.tenantId).toBe(TENANT);
    expect(persisted?.runId).toBe(RUN_ID);
    expect(persisted?.agentId).toBe(AGENT_ID);
    expect(persisted?.actionType).toBe('draft_email_reply');
    expect(persisted?.payload).toEqual({ to: 'a@b.com', subject: 's', body: 'b' });
    expect(persisted?.evidence).toHaveLength(1);
    expect(persisted?.expectedOutcome).toBe('reply sent');
    expect(persisted?.confidence).toBe(0.8);
  });

  it('rejects calls for non-proposal tool names', async () => {
    const exec = makeProposalToolExecutor({
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    await expect(
      exec('search_documents', { q: 'x' }, ctx),
    ).rejects.toThrow(/non-proposal tool/);
  });

  it('throws when action_type is missing', async () => {
    const exec = makeProposalToolExecutor({
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    await expect(
      exec('create_proposal', { payload: { a: 1 } }, ctx),
    ).rejects.toThrow(/action_type is required/);
  });

  it('throws when payload is missing', async () => {
    const exec = makeProposalToolExecutor({
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    await expect(
      exec('create_proposal', { action_type: 'draft_email_reply' }, ctx),
    ).rejects.toThrow(/payload is required/);
  });

  it('stamps every proposal with the deps tenantId/runId/agentId — never reads from input', async () => {
    const exec = makeProposalToolExecutor({
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    // Even if the agent tries to pass a different tenantId in the payload,
    // the executor MUST stamp from deps. (Defense against prompt injection.)
    const result = (await exec(
      'create_proposal',
      {
        action_type: 'draft_email_reply',
        payload: { to: 'a@b.com', subject: 's', body: 'b' },
        // attempt to override:
        tenantId: '00000000-0000-0000-0000-00000000000b',
        runId: 'attacker-run',
      },
      ctx,
    )) as { proposal_id: string };
    const p = await proposals.get(result.proposal_id);
    expect(p?.tenantId).toBe(TENANT);
    expect(p?.runId).toBe(RUN_ID);
    expect(p?.agentId).toBe(AGENT_ID);
  });
});

describe('withProposalTool', () => {
  let dir: string;
  let proposals: FileProposalStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-with-proposal-'));
    proposals = new FileProposalStore(join(dir, 'proposals.json'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('routes create_proposal to the proposal handler', async () => {
    const base: ToolExecutor = vi.fn(async () => ({ fromBase: true }));
    const exec = withProposalTool(base, {
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    const result = (await exec(
      'create_proposal',
      { action_type: 'draft_email_reply', payload: { to: 'x' } },
      ctx,
    )) as { proposal_id: string };
    expect(result.proposal_id).toBeDefined();
    expect(base).not.toHaveBeenCalled();
  });

  it('falls through to base for all other tool names', async () => {
    const base: ToolExecutor = vi.fn(async () => ({ fromBase: true }));
    const exec = withProposalTool(base, {
      proposals,
      tenantId: TENANT,
      runId: RUN_ID,
      agentId: AGENT_ID,
    });
    const result = await exec('search_documents', { q: 'x' }, ctx);
    expect(result).toEqual({ fromBase: true });
    expect(base).toHaveBeenCalledWith('search_documents', { q: 'x' }, ctx);
  });
});
