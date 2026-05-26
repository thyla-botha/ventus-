import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { resetAppState } from '../state.js';
import { readJson } from '../test-helpers.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const USER = '00000000-0000-0000-0000-000000000111';
const HEADERS = { 'x-tenant-id': TENANT, 'x-user-id': USER };

interface SkillView {
  name: string;
  description: string;
  tier: number;
  model: string;
  allowedTools: string[];
  contentHash: string;
}
interface SkillsListBody { skills: SkillView[] }
interface SkillBody { skill: SkillView }

async function writeSkill(dir: string, name: string, frontmatter: Record<string, unknown>) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map((x) => `  - ${x}`).join('\n')}`;
      }
      return `${k}: ${v}`;
    })
    .join('\n');
  const body = `---\n${fm}\n---\n\nSystem prompt for ${name}.\n`;
  await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8');
}

describe('GET /v1/skills', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-skills-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    resetAppState();
    app = createApp();
  });

  afterEach(async () => {
    delete process.env.VENTUS_SKILLS_DIR;
    delete process.env.VENTUS_PROPOSAL_STORE;
    delete process.env.VENTUS_AUDIT_STORE;
    delete process.env.VENTUS_OUTBOX;
    delete process.env.VENTUS_RUN_STORE;
    delete process.env.VENTUS_TENANT_PROFILE_STORE;
    resetAppState();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 401 without tenant headers', async () => {
    const res = await app.request('/v1/skills');
    expect(res.status).toBe(401);
  });

  it('lists discovered skills', async () => {
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    await writeSkill(dir, 'triage', {
      name: 'triage',
      description: 'Triages tickets',
      tier: 1,
      allowed_tools: ['search_documents'],
      model: 'claude-haiku-4-5-20251001',
    });
    const res = await app.request('/v1/skills', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await readJson<SkillsListBody>(res);
    const names = body.skills.map((s) => s.name).sort();
    expect(names).toEqual(['reply-drafter', 'triage']);
  });

  it('returns the SkillView shape (no systemPrompt or path leaked)', async () => {
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/skills', { headers: HEADERS });
    const body = await readJson<SkillsListBody>(res);
    const s = body.skills[0]!;
    expect(s.name).toBe('reply-drafter');
    expect(s.allowedTools).toEqual(['create_proposal']);
    // Sensitive/large fields must not appear on the wire
    expect((s as unknown as Record<string, unknown>).systemPrompt).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).path).toBeUndefined();
    // contentHash IS on the wire — auditors compare it to a Run row's
    // skillContentHash to detect "the skill has been edited since this run".
    expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns an empty list when no skills are present', async () => {
    const res = await app.request('/v1/skills', { headers: HEADERS });
    const body = await readJson<SkillsListBody>(res);
    expect(body.skills).toEqual([]);
  });
});

describe('GET /v1/skills/:name', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-skills-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    resetAppState();
    app = createApp();
  });

  afterEach(async () => {
    delete process.env.VENTUS_SKILLS_DIR;
    delete process.env.VENTUS_PROPOSAL_STORE;
    delete process.env.VENTUS_AUDIT_STORE;
    delete process.env.VENTUS_OUTBOX;
    delete process.env.VENTUS_RUN_STORE;
    delete process.env.VENTUS_TENANT_PROFILE_STORE;
    resetAppState();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the named skill', async () => {
    await writeSkill(dir, 'reply-drafter', {
      name: 'reply-drafter',
      description: 'Drafts replies',
      tier: 2,
      allowed_tools: ['create_proposal'],
      model: 'claude-sonnet-4-6',
    });
    const res = await app.request('/v1/skills/reply-drafter', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = await readJson<SkillBody>(res);
    expect(body.skill.name).toBe('reply-drafter');
  });

  it('returns 404 for unknown skill', async () => {
    const res = await app.request('/v1/skills/nope', { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});
