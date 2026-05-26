export type AgentTier = 1 | 2 | 3;

// On-disk SKILL.md frontmatter. Matches the Claude Skills format so Skills are
// portable to Claude.ai, Claude Code, and other runtimes — with extra fields
// for tenant-platform concerns (tier, cost_ceiling, etc.).
export interface SkillFrontmatter {
  name: string;
  description: string;
  tier: AgentTier;
  allowed_tools: string[];
  model?: string;
  max_steps?: number;
  max_tokens?: number;
  cost_ceiling_cents?: number;
  // Tier-3 policy: which resources the skill is allowed to act on.
  // Required when tier=3, ignored otherwise.
  policy?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  tier: AgentTier;
  allowedTools: string[];
  model: string;
  maxSteps: number;
  maxTokens: number;
  costCeilingCents: number | null;
  policy: Record<string, unknown> | null;
  systemPrompt: string;
  // Absolute filesystem path of the SKILL.md file.
  path: string;
  // SHA-256 (hex) of the raw SKILL.md bytes — frontmatter + body, including
  // whitespace. Pins the exact version of the skill that produced a Run so
  // we can audit "which bytes ran" even after the on-disk file changes.
  // Whitespace-sensitive on purpose: a stray trailing newline IS a different
  // skill version. If that becomes noisy in practice we'll hash a canonical
  // form, but right now byte-identity is the safest invariant.
  contentHash: string;
}
