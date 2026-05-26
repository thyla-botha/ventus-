import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Skill } from './types.js';
import { validateSkill, SkillValidationError } from './validate.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_TOKENS = 4096;

export async function loadSkill(skillPath: string): Promise<Skill> {
  const absPath = resolve(skillPath);
  const stats = await stat(absPath);
  // Accept either a SKILL.md file directly or a directory containing one.
  const filePath = stats.isDirectory() ? join(absPath, 'SKILL.md') : absPath;

  // Read as Buffer first so the hash is over the raw file bytes — not a
  // UTF-8-normalised string. For typical SKILL.md content the two are
  // identical, but the byte-hash is what "pins the exact bytes" actually
  // promises and survives a future SKILL.md that uses non-UTF-8 codepoints.
  const buf = await readFile(filePath);
  const contentHash = createHash('sha256').update(buf).digest('hex');
  const raw = buf.toString('utf8');
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new SkillValidationError('missing YAML frontmatter (--- ... ---)', filePath);
  }
  const yamlBlock = m[1] ?? '';
  const body = (m[2] ?? '').trim();

  const parsed = parseYaml(yamlBlock);
  const fm = validateSkill(parsed, filePath);

  if (body.length === 0) {
    throw new SkillValidationError('skill body (system prompt) is empty', filePath);
  }

  return {
    name: fm.name,
    description: fm.description,
    tier: fm.tier,
    allowedTools: fm.allowed_tools,
    model: fm.model ?? DEFAULT_MODEL,
    maxSteps: fm.max_steps ?? DEFAULT_MAX_STEPS,
    maxTokens: fm.max_tokens ?? DEFAULT_MAX_TOKENS,
    costCeilingCents: fm.cost_ceiling_cents ?? null,
    policy: fm.policy ?? null,
    systemPrompt: body,
    path: filePath,
    contentHash,
  };
}

export async function discoverSkills(rootDir: string): Promise<Skill[]> {
  const out: Skill[] = [];
  const root = resolve(rootDir);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === 'SKILL.md') {
        out.push(await loadSkill(p));
      } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        await walk(p);
      }
    }
  }

  await walk(root);
  return out;
}
