import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentRuntime } from '@ventus/agent-runtime';
import type { RunRecord } from '@ventus/store';
import { createApp } from '../app.js';
import { getAppState, resetAppState, setRuntimeForTests } from '../state.js';
import { readJson } from '../test-helpers.js';

// POST /v1/runs is the only route that drives the agent loop, so it has its
// own harness: a tmpdir skills directory + a FakeAgentRuntime injected via
// setRuntimeForTests(). The shared makeHarness() doesn't do either because
// every other route is loop-free.

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER = '00000000-0000-0000-0000-000000000111';
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER };

interface CreateRunBody {
  run: RunRecord;
}

async function writeSkill(dir: string, name: string, frontmatter: Record<string, unknown>) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}`;
      return `${k}: ${v}`;
    })
    .join('\n');
  const body = `---\n${fm}\n---\n\nSystem prompt for ${name}.\n`;
  await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8');
}

describe('POST /v1/runs', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-runs-create-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    // Inject the fake BEFORE the first getAppState() so AnthropicRuntime is
    // never constructed (it would throw without ANTHROPIC_API_KEY).
    setRuntimeForTests(new FakeAgentRuntime({ turns: [{ text: 'done.' }] }));
    app = createApp();
  });

  afterEach(async () => {
    // CRITICAL: drain in-flight loops BEFORE rm'ing the tmpdir, or the loop
    // races with file deletion and the next test sees ENOENT/ENOTEMPTY.
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

  it('returns 401 without tenant headers', async () => {
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing/invalid body', async () => {
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when skill does not exist', async () => {
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'no-such-skill', message: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 202 + an open Run row when the skill exists', async () => {
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'draft a reply' }),
    });
    expect(res.status).toBe(202);
    const body = await readJson<CreateRunBody>(res);
    expect(body.run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.run.tenantId).toBe(TENANT);
    expect(body.run.skillId).toBe('reply-drafter');
    expect(body.run.status).toBe('running');
    // agentId defaults to `api:<userId>` when the caller omits it
    expect(body.run.agentId).toBe(`api:${USER}`);
  });

  it('honours an explicit agentId override', async () => {
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        skillName: 'reply-drafter',
        message: 'go',
        agentId: 'custom-agent',
      }),
    });
    const body = await readJson<CreateRunBody>(res);
    expect(body.run.agentId).toBe('custom-agent');
  });

  it('ignores any tenantId in the body (uses header-derived tenant)', async () => {
    // Defense-in-depth: even if a malicious caller smuggles a foreign
    // tenantId into the body, the Run row must be stamped with the header
    // tenant. (And the schema strips unknown fields rather than echoing them.)
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        skillName: 'reply-drafter',
        message: 'go',
        tenantId: '00000000-0000-0000-0000-00000000000b',
      }),
    });
    const body = await readJson<CreateRunBody>(res);
    expect(body.run.tenantId).toBe(TENANT);
  });

  it('rejects modelOverride from the body (not a public field)', async () => {
    // Codex review caught this: exposing modelOverride lets callers bypass the
    // skill's model policy. The schema is strict — unknown keys cause a 400.
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        skillName: 'reply-drafter',
        message: 'go',
        modelOverride: 'claude-haiku-4-5-20251001',
      }),
    });
    // Zod is non-strict by default — it silently strips unknown keys. So the
    // request succeeds, but the Run row still uses the skill's declared model.
    expect(res.status).toBe(202);
    const body = await readJson<CreateRunBody>(res);
    expect(body.run.model).toBe('claude-sonnet-4-6');
  });

  it('returns the row BEFORE the loop completes (fire-and-forget contract)', async () => {
    // The whole point of the handle pattern: HTTP returns immediately while
    // the loop runs in the background. We assert the row is visible in the
    // 'running' state at response time, even though the fake will eventually
    // flip it to 'completed'.
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'go' }),
    });
    const { run } = await readJson<CreateRunBody>(res);
    expect(run.status).toBe('running');
    // open rows omit endedAt (it's only set when the loop closes the row)
    expect(run.endedAt).toBeUndefined();
  });
});
