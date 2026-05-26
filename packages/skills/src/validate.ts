import type { SkillFrontmatter, AgentTier } from './types.js';

export class SkillValidationError extends Error {
  constructor(message: string, readonly path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'SkillValidationError';
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function validateSkill(raw: unknown, path?: string): SkillFrontmatter {
  if (!raw || typeof raw !== 'object') {
    throw new SkillValidationError('frontmatter must be an object', path);
  }
  const fm = raw as Record<string, unknown>;

  if (!isString(fm.name) || fm.name.length === 0) {
    throw new SkillValidationError('name must be a non-empty string', path);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fm.name)) {
    throw new SkillValidationError(
      `name must be kebab-case (a-z, 0-9, -). Got: ${fm.name}`,
      path,
    );
  }

  if (!isString(fm.description) || fm.description.length === 0) {
    throw new SkillValidationError('description must be a non-empty string', path);
  }

  if (fm.tier !== 1 && fm.tier !== 2 && fm.tier !== 3) {
    throw new SkillValidationError('tier must be 1, 2, or 3', path);
  }

  if (!isStringArray(fm.allowed_tools)) {
    throw new SkillValidationError('allowed_tools must be a string array', path);
  }

  if (fm.tier === 3 && (!fm.policy || typeof fm.policy !== 'object')) {
    throw new SkillValidationError(
      'tier-3 skills must declare a policy object scoping their writes',
      path,
    );
  }

  if (fm.model !== undefined && !isString(fm.model)) {
    throw new SkillValidationError('model must be a string when set', path);
  }

  if (fm.max_steps !== undefined && (typeof fm.max_steps !== 'number' || fm.max_steps < 1)) {
    throw new SkillValidationError('max_steps must be a positive integer', path);
  }

  if (fm.max_tokens !== undefined && (typeof fm.max_tokens !== 'number' || fm.max_tokens < 1)) {
    throw new SkillValidationError('max_tokens must be a positive integer', path);
  }

  if (fm.cost_ceiling_cents !== undefined
      && (typeof fm.cost_ceiling_cents !== 'number' || fm.cost_ceiling_cents < 0)) {
    throw new SkillValidationError('cost_ceiling_cents must be a non-negative number', path);
  }

  return {
    name: fm.name,
    description: fm.description,
    tier: fm.tier as AgentTier,
    allowed_tools: fm.allowed_tools,
    model: fm.model as string | undefined,
    max_steps: fm.max_steps as number | undefined,
    max_tokens: fm.max_tokens as number | undefined,
    cost_ceiling_cents: fm.cost_ceiling_cents as number | undefined,
    policy: fm.policy as Record<string, unknown> | undefined,
  };
}
