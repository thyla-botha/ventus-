import { Hono } from 'hono';
import { getAppState } from '../state.js';

// HTTP surface for the skill catalog.
//
//   GET /v1/skills          list all skills available to this deployment
//   GET /v1/skills/:name    fetch one skill by name
//
// Skills are platform-global — the same skill file serves every tenant. The
// route still goes through the tenant middleware (so unauthenticated callers
// are rejected) but the returned set does not vary by tenant.

interface SkillView {
  name: string;
  description: string;
  tier: number;
  model: string;
  maxSteps: number;
  maxTokens: number;
  costCeilingCents: number | null;
  allowedTools: string[];
  // SHA-256 of the SKILL.md bytes currently on disk. Lets an auditor
  // compare against a Run row's skillContentHash to detect "this run used
  // an older version of the skill than the catalog has now".
  contentHash: string;
}

function toView(s: {
  name: string;
  description: string;
  tier: number;
  model: string;
  maxSteps: number;
  maxTokens: number;
  costCeilingCents: number | null;
  allowedTools: string[];
  contentHash: string;
}): SkillView {
  return {
    name: s.name,
    description: s.description,
    tier: s.tier,
    model: s.model,
    maxSteps: s.maxSteps,
    maxTokens: s.maxTokens,
    costCeilingCents: s.costCeilingCents,
    allowedTools: s.allowedTools,
    contentHash: s.contentHash,
  };
}

export const skills = new Hono()
  .get('/', async (c) => {
    const { getSkills } = getAppState();
    const all = await getSkills();
    return c.json({ skills: all.map(toView) });
  })
  .get('/:name', async (c) => {
    const name = c.req.param('name');
    const { getSkills } = getAppState();
    const all = await getSkills();
    const skill = all.find((s) => s.name === name);
    if (!skill) return c.json({ error: 'not found' }, 404);
    return c.json({ skill: toView(skill) });
  });
