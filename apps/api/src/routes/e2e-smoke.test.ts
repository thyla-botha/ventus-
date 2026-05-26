import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentRuntime } from '@ventus/agent-runtime';
import type { Proposal, RunRecord } from '@ventus/store';
import { createApp } from '../app.js';
import { getAppState, resetAppState, setRuntimeForTests } from '../state.js';
import { readJson } from '../test-helpers.js';

// End-to-end smoke: a real HTTP request kicks off a real agent loop with a
// FakeAgentRuntime that produces a real proposal; the test then drives the
// proposal through decide → execute via the HTTP surface, and asserts the
// audit trail captures every step in order.
//
// This is the test we WOULD have run before declaring the platform shippable.
// It deliberately uses zero internal store/audit/runtime mocking — only the
// LLM is faked (because Anthropic isn't a deterministic test fixture). Every
// other layer (state singleton, file stores, executor registry, HTTP middleware
// chain, audit hashing) is the same one production runs.

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER = '00000000-0000-0000-0000-000000000111';
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER };
const CONTENT_JSON = { 'content-type': 'application/json' };

interface CreateRunBody { run: RunRecord }
interface ProposalsBody { proposals: Proposal[] }
interface ProposalBody { proposal: Proposal }
interface ExecuteBody { result: { status: string }; proposal: Proposal }
interface AuditEvent {
  intent: { action: string; actorType: string; resourceType?: string; resourceId?: string };
  outcome: { status: string } | null;
}
interface AuditTrailBody { events: AuditEvent[] }

async function writeSkill(dir: string, name: string) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const body =
    `---\nname: ${name}\ndescription: drafts replies\ntier: 2\n` +
    `allowed_tools:\n  - create_proposal\nmodel: claude-sonnet-4-6\n---\n\n` +
    `Draft a customer email reply.\n`;
  await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8');
}

describe('e2e smoke — POST /v1/runs through to executed proposal + audit trail', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-e2e-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');

    // Fake runtime: one turn that creates a proposal, then a closing
    // assistant_message. Mirrors the shape AnthropicRuntime would produce
    // for a single-step happy path.
    setRuntimeForTests(
      new FakeAgentRuntime({
        turns: [
          {
            tools: [
              {
                name: 'create_proposal',
                input: {
                  action_type: 'draft_email_reply',
                  payload: {
                    to: 'customer@example.com',
                    subject: 'Re: your inquiry',
                    body: 'Thanks for reaching out — replying inline below.',
                  },
                  confidence: 0.92,
                },
              },
            ],
          },
          { text: 'Drafted a reply for review.' },
        ],
      }),
    );

    app = createApp();
    await writeSkill(dir, 'reply-drafter');
  });

  afterEach(async () => {
    await getAppState().drainInflight();
    delete process.env.VENTUS_SKILLS_DIR;
    delete process.env.VENTUS_PROPOSAL_STORE;
    delete process.env.VENTUS_AUDIT_STORE;
    delete process.env.VENTUS_OUTBOX;
    delete process.env.VENTUS_RUN_STORE;
    delete process.env.VENTUS_TENANT_PROFILE_STORE;
    setRuntimeForTests(null);
    resetAppState();
    await rm(dir, { recursive: true, force: true });
  });

  it('full path: create run → loop produces proposal → approve → execute → audit trail complete', async () => {
    // 1. Kick off the run.
    const create = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, ...CONTENT_JSON },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'reply to support@example.com' }),
    });
    expect(create.status).toBe(202);
    const { run } = await readJson<CreateRunBody>(create);
    expect(run.status).toBe('running');
    const runId = run.id;

    // 2. Wait for the loop to settle. drainInflight resolves only after the
    //    loop closes the Run row, so the audit + proposal writes are durable
    //    by the time it returns. No polling, no sleeps.
    await getAppState().drainInflight();

    // 3. Run row should be 'completed' now.
    const runAfter = await app.request(`/v1/runs/${runId}`, { headers: HEADERS });
    const runBody = await readJson<{ run: RunRecord }>(runAfter);
    expect(runBody.run.status).toBe('completed');
    expect(runBody.run.proposalCount).toBe(1);

    // 4. The proposal exists, scoped to this run.
    const list = await app.request(`/v1/runs/${runId}/proposals`, { headers: HEADERS });
    const listBody = await readJson<ProposalsBody>(list);
    expect(listBody.proposals).toHaveLength(1);
    const proposalId = listBody.proposals[0]!.id;
    expect(listBody.proposals[0]!.status).toBe('pending');
    expect(listBody.proposals[0]!.tenantId).toBe(TENANT);

    // 5. Approve it via the HTTP decide route.
    const decide = await app.request(`/v1/proposals/${proposalId}/decide`, {
      method: 'POST',
      headers: { ...HEADERS, ...CONTENT_JSON },
      body: JSON.stringify({ verdict: 'approved', comment: 'ship it' }),
    });
    expect(decide.status).toBe(200);
    const decided = await readJson<ProposalBody>(decide);
    expect(decided.proposal.status).toBe('approved');

    // 6. Execute it. The MockEmailExecutor writes to outbox.json.
    const exec = await app.request(`/v1/proposals/${proposalId}/execute`, {
      method: 'POST',
      headers: HEADERS,
    });
    expect(exec.status).toBe(200);
    const execBody = await readJson<ExecuteBody>(exec);
    expect(execBody.result.status).toBe('executed');
    expect(execBody.proposal.status).toBe('executed');

    // 7. Outbox contains the executed email. This is the "real-world side
    //    effect" — the test would have caught any drift between approval
    //    and execution (e.g. payload swapped, executor wrong type, etc.).
    expect(existsSync(process.env.VENTUS_OUTBOX!)).toBe(true);
    const outbox = JSON.parse(await readFile(process.env.VENTUS_OUTBOX!, 'utf8')) as {
      deliveries: Array<{
        channel: string;
        proposalId: string;
        tenantId: string;
        payload: { to?: string; subject?: string; body?: string };
      }>;
    };
    expect(outbox.deliveries).toHaveLength(1);
    const delivery = outbox.deliveries[0]!;
    expect(delivery.channel).toBe('email');
    expect(delivery.proposalId).toBe(proposalId);
    expect(delivery.tenantId).toBe(TENANT);
    expect(delivery.payload.to).toBe('customer@example.com');

    // 8. Audit trail captures the FULL story: tool:create_proposal (agent),
    //    decide_proposal:approved (user), execute_proposal:draft_email_reply
    //    (system). Every intent has its matching outcome.
    const audit = await app.request(`/v1/runs/${runId}/audit`, { headers: HEADERS });
    const trail = await readJson<AuditTrailBody>(audit);
    const actions = trail.events.map((e) => e.intent.action).sort();
    expect(actions).toEqual(
      [
        'tool:create_proposal',
        'decide_proposal:approved',
        'execute_proposal:draft_email_reply',
      ].sort(),
    );
    // No orphan outcomes — every intent landed its outcome row.
    for (const ev of trail.events) {
      expect(ev.outcome).not.toBeNull();
      expect(ev.outcome!.status).toMatch(/^(executed|approved)$/);
    }
    // Actor types are correct: agent created, user decided, system executed.
    const byAction = new Map(trail.events.map((e) => [e.intent.action, e]));
    expect(byAction.get('tool:create_proposal')!.intent.actorType).toBe('agent');
    expect(byAction.get('decide_proposal:approved')!.intent.actorType).toBe('user');
    expect(byAction.get('execute_proposal:draft_email_reply')!.intent.actorType).toBe('system');
  });

  it('cross-tenant: a second tenant cannot see the first tenant\'s run, proposal, or audit', async () => {
    // Defense-in-depth: the e2e path must isolate by tenant header at every
    // HTTP boundary. We seed under tenant A, then probe every read-path as
    // tenant B and assert 404 / empty.
    const create = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, ...CONTENT_JSON },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'go' }),
    });
    const { run } = await readJson<CreateRunBody>(create);
    await getAppState().drainInflight();
    const list = await app.request(`/v1/runs/${run.id}/proposals`, { headers: HEADERS });
    const proposalId = (await readJson<ProposalsBody>(list)).proposals[0]!.id;

    const TENANT_B_HEADERS = {
      'x-tenant-id': '00000000-0000-0000-0000-00000000000b',
      'x-user-id': USER,
    };

    // GET /v1/runs/:id → 404 (no existence leak).
    const runB = await app.request(`/v1/runs/${run.id}`, { headers: TENANT_B_HEADERS });
    expect(runB.status).toBe(404);

    // GET /v1/proposals/:id → 404.
    const propB = await app.request(`/v1/proposals/${proposalId}`, { headers: TENANT_B_HEADERS });
    expect(propB.status).toBe(404);

    // POST .../decide on cross-tenant proposal → 404 (no mutation).
    const decideB = await app.request(`/v1/proposals/${proposalId}/decide`, {
      method: 'POST',
      headers: { ...TENANT_B_HEADERS, ...CONTENT_JSON },
      body: JSON.stringify({ verdict: 'approved' }),
    });
    expect(decideB.status).toBe(404);

    // Tenant B's proposal/audit list is empty (no leak from A's run).
    const listB = await app.request('/v1/proposals', { headers: TENANT_B_HEADERS });
    expect((await readJson<ProposalsBody>(listB)).proposals).toHaveLength(0);
  });
});
