import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadSkill } from '@ventus/skills';
import { FileAuditStore, FileProposalStore, FileRunStore } from '@ventus/store';
import { AnthropicRuntime } from './anthropic.js';
import { runAgent } from './run-agent.js';
import type { RunStepEvent } from './runtime.js';

// Local CLI for firing a single agent run against a Skill, using mock tools.
// All orchestration (run lifecycle, audit wiring, proposal tool, executor
// composition, cost/proposal tracking) lives in runAgent(). This file only
// owns the CLI surface: argv parsing, stdout streaming, and exit codes.
//
//   pnpm --filter @ventus/agent-runtime run-agent \
//     --skill ../../skills/customer-reply-drafter \
//     --message "draft a reply to doc-1"

const DEFAULT_PROPOSAL_STORE = '.ventus/proposals.json';
const DEFAULT_AUDIT_STORE = '.ventus/audit.json';
const DEFAULT_RUN_STORE = '.ventus/runs.json';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      skill: { type: 'string' },
      message: { type: 'string' },
      tenant: { type: 'string' },
      model: { type: 'string' },
      pretty: { type: 'boolean', default: false },
      'proposal-store': { type: 'string' },
      'audit-store': { type: 'string' },
      'run-store': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  if (!values.skill || !values.message) {
    process.stderr.write(
      'usage: run-agent --skill <path> --message <text> [--tenant <uuid>] [--model <id>] [--pretty]\n' +
        '                 [--proposal-store <path>] [--audit-store <path>] [--run-store <path>]\n',
    );
    return 2;
  }

  const skill = await loadSkill(values.skill);
  const tenantId = values.tenant ?? '00000000-0000-0000-0000-000000000000';
  const agentId = `cli:${skill.name}`;

  const proposalStorePath = resolve(values['proposal-store'] ?? DEFAULT_PROPOSAL_STORE);
  const auditStorePath = resolve(values['audit-store'] ?? DEFAULT_AUDIT_STORE);
  const runStorePath = resolve(values['run-store'] ?? DEFAULT_RUN_STORE);

  const deps = {
    proposals: new FileProposalStore(proposalStorePath),
    audit: new FileAuditStore(auditStorePath),
    runs: new FileRunStore(runStorePath),
    runtime: new AnthropicRuntime(),
  };

  const startedAt = Date.now();
  const onEvent = (event: RunStepEvent) => {
    const line = values.pretty ? prettyEvent(event) : JSON.stringify(event);
    process.stdout.write(line + '\n');
  };

  const result = await runAgent(deps, {
    skill,
    tenantId,
    agentId,
    userMessage: values.message,
    modelOverride: values.model,
    onEvent,
  });

  if (result.unknownTools.length) {
    process.stderr.write(
      `warning: skill allows tools not present in local runtime: ${result.unknownTools.join(', ')}\n`,
    );
  }

  const elapsedMs = Date.now() - startedAt;
  process.stderr.write(
    `\n[done in ${elapsedMs}ms, status=${result.status}, cost=${result.totalCostMicros}µ$, proposals=${result.proposalCount}]\n` +
      `  run:       ${result.runId}\n` +
      `  runs:      ${runStorePath}\n` +
      `  proposals: ${proposalStorePath}\n` +
      `  audit:     ${auditStorePath}\n`,
  );
  // 0 for any "stopped intentionally" outcome (completed by agent, halted by
  // guardrail, aborted by user/operator); 1 only for actual failures.
  return result.status === 'failed' ? 1 : 0;
}

function prettyEvent(event: { type: string } & Record<string, unknown>): string {
  return `[${event.type}] ${JSON.stringify(omit(event, 'type'), null, 2)}`;
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (k !== key) out[k] = obj[k];
  return out as Partial<T>;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
