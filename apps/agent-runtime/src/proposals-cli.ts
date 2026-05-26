import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { hashPayload } from '@ventus/audit';
import {
  FileAuditStore,
  FileProposalStore,
  type AuditStore,
  type Proposal,
  type ProposalStatus,
} from '@ventus/store';
import { buildLocalRegistry, executeProposal, executeAllApproved } from './executors/index.js';

// Local CLI for inspecting, deciding on, and executing proposals staged by
// Tier 2 agents. Uses the same file-backed stores the agent runtime writes
// to. No DB, no auth. Every human decision and every execution writes an
// audit intent+outcome.
//
//   pnpm --filter @ventus/agent-runtime proposals list
//   pnpm --filter @ventus/agent-runtime proposals list --status pending
//   pnpm --filter @ventus/agent-runtime proposals show <id>
//   pnpm --filter @ventus/agent-runtime proposals approve <id> [--comment "looks good"]
//   pnpm --filter @ventus/agent-runtime proposals reject  <id> [--comment "wrong tone"]
//   pnpm --filter @ventus/agent-runtime proposals execute <id>
//   pnpm --filter @ventus/agent-runtime proposals execute --all

const DEFAULT_STORE_PATH = '.ventus/proposals.json';
const DEFAULT_AUDIT_PATH = '.ventus/audit.json';
const DEFAULT_OUTBOX_PATH = '.ventus/outbox.json';
const DEFAULT_APPROVER = 'cli-user';

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      store: { type: 'string' },
      'audit-store': { type: 'string' },
      outbox: { type: 'string' },
      status: { type: 'string' },
      tenant: { type: 'string' },
      limit: { type: 'string' },
      comment: { type: 'string' },
      approver: { type: 'string' },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const [command, ...rest] = positionals;
  if (!command) {
    printUsage();
    return 2;
  }

  const storePath = resolve(values.store ?? DEFAULT_STORE_PATH);
  const auditPath = resolve(values['audit-store'] ?? DEFAULT_AUDIT_PATH);
  const outboxPath = resolve(values.outbox ?? DEFAULT_OUTBOX_PATH);
  const store = new FileProposalStore(storePath);
  const audit = new FileAuditStore(auditPath);

  switch (command) {
    case 'list':
      return list(store, {
        status: values.status as ProposalStatus | undefined,
        tenantId: values.tenant,
        limit: values.limit ? Number(values.limit) : undefined,
        json: values.json,
      });
    case 'show': {
      const id = rest[0];
      if (!id) {
        process.stderr.write('usage: proposals show <id>\n');
        return 2;
      }
      return show(store, id, values.json);
    }
    case 'approve':
    case 'reject': {
      const id = rest[0];
      if (!id) {
        process.stderr.write(`usage: proposals ${command} <id> [--comment "..."]\n`);
        return 2;
      }
      return decide(store, audit, id, {
        verdict: command === 'approve' ? 'approved' : 'rejected',
        approverId: values.approver ?? DEFAULT_APPROVER,
        comment: values.comment,
      });
    }
    case 'execute': {
      const registry = buildLocalRegistry(outboxPath);
      const deps = { proposals: store, audit, registry };
      if (values.all) {
        const results = await executeAllApproved(deps, { tenantId: values.tenant });
        if (values.json) {
          process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        } else if (results.length === 0) {
          process.stdout.write('(no approved proposals to execute)\n');
        } else {
          for (const r of results) {
            process.stdout.write(formatExecuteResult(r) + '\n');
          }
        }
        return results.some((r) => r.status === 'failed') ? 1 : 0;
      }
      const id = rest[0];
      if (!id) {
        process.stderr.write('usage: proposals execute <id> | proposals execute --all\n');
        return 2;
      }
      const result = await executeProposal(id, deps);
      if (values.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(formatExecuteResult(result) + '\n');
      }
      return result.status === 'executed' ? 0 : 1;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      printUsage();
      return 2;
  }
}

interface ListOptions {
  status?: ProposalStatus;
  tenantId?: string;
  limit?: number;
  json: boolean;
}

async function list(store: FileProposalStore, opts: ListOptions): Promise<number> {
  const rows = await store.list({
    status: opts.status,
    tenantId: opts.tenantId,
    limit: opts.limit,
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write('(no proposals)\n');
    return 0;
  }
  for (const p of rows) {
    process.stdout.write(formatRow(p) + '\n');
  }
  return 0;
}

async function show(
  store: FileProposalStore,
  id: string,
  json: boolean,
): Promise<number> {
  const p = await store.get(id);
  if (!p) {
    process.stderr.write(`not found: ${id}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(p, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(formatDetail(p) + '\n');
  return 0;
}

interface DecideArgs {
  verdict: 'approved' | 'rejected';
  approverId: string;
  comment?: string;
}

async function decide(
  store: FileProposalStore,
  audit: AuditStore,
  id: string,
  args: DecideArgs,
): Promise<number> {
  const startedAt = Date.now();
  const existing = await store.get(id);
  if (!existing) {
    process.stderr.write(`not found: ${id}\n`);
    return 1;
  }

  const payload = { verdict: args.verdict, comment: args.comment ?? null };
  const intent = await audit.recordIntent({
    tenantId: existing.tenantId,
    runId: existing.runId,
    stepNo: 0,
    actorType: 'user',
    actorId: args.approverId,
    action: `decide_proposal:${args.verdict}`,
    resourceType: 'proposal',
    resourceId: existing.id,
    payload,
    payloadHash: hashPayload(payload),
  });

  try {
    const updated = await store.decide(id, {
      verdict: args.verdict,
      approverId: args.approverId,
      comment: args.comment,
      decidedAt: new Date().toISOString(),
    });
    await audit.recordOutcome({
      intentId: intent.id,
      tenantId: existing.tenantId,
      status: args.verdict === 'approved' ? 'approved' : 'rejected',
      result: { newStatus: updated.status },
      durationMs: Date.now() - startedAt,
    });
    process.stdout.write(`${args.verdict} ${updated.id} (status=${updated.status})\n`);
    return 0;
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    try {
      await audit.recordOutcome({
        intentId: intent.id,
        tenantId: existing.tenantId,
        status: 'failed',
        errorText,
        durationMs: Date.now() - startedAt,
      });
    } catch {
      // outcome write failed — intent stays as orphan
    }
    process.stderr.write(`${errorText}\n`);
    return 1;
  }
}

function formatRow(p: Proposal): string {
  const conf = p.confidence !== undefined ? p.confidence.toFixed(2) : '-';
  return [
    p.id.slice(0, 8),
    p.status.padEnd(9),
    p.actionType.padEnd(22),
    `conf=${conf}`,
    p.createdAt,
  ].join('  ');
}

function formatDetail(p: Proposal): string {
  const lines: string[] = [];
  lines.push(`id:            ${p.id}`);
  lines.push(`status:        ${p.status}`);
  lines.push(`action_type:   ${p.actionType}`);
  lines.push(`resource:      ${p.resourceType ?? '-'} / ${p.resourceId ?? '-'}`);
  lines.push(`tenant_id:     ${p.tenantId}`);
  lines.push(`run_id:        ${p.runId}`);
  lines.push(`agent_id:      ${p.agentId}`);
  lines.push(`confidence:    ${p.confidence ?? '-'}`);
  lines.push(`expected:      ${p.expectedOutcome ?? '-'}`);
  lines.push(`created_at:    ${p.createdAt}`);
  lines.push(`updated_at:    ${p.updatedAt}`);
  if (p.decision) {
    lines.push(`decision:      ${p.decision.verdict} by ${p.decision.approverId} @ ${p.decision.decidedAt}`);
    if (p.decision.comment) lines.push(`  comment:     ${p.decision.comment}`);
  }
  lines.push('payload:');
  lines.push(indent(JSON.stringify(p.payload, null, 2), 2));
  if (p.evidence && p.evidence.length > 0) {
    lines.push('evidence:');
    lines.push(indent(JSON.stringify(p.evidence, null, 2), 2));
  }
  return lines.join('\n');
}

function formatExecuteResult(r: {
  proposalId: string;
  status: string;
  result?: unknown;
  error?: string;
}): string {
  const head = `${r.status.padEnd(8)}  ${r.proposalId}`;
  if (r.error) return `${head}  error=${r.error}`;
  if (r.result) return `${head}  ${JSON.stringify(r.result)}`;
  return head;
}

function indent(s: string, n: number): string {
  const pad = ' '.repeat(n);
  return s.split('\n').map((l) => pad + l).join('\n');
}

function printUsage(): void {
  process.stderr.write(
    [
      'usage: proposals <command> [args]',
      '',
      'commands:',
      '  list                          list proposals (newest first)',
      '  list --status pending         filter by status',
      '  list --tenant <uuid>          filter by tenant',
      '  list --limit 10               limit rows',
      '  show <id>                     show one proposal',
      '  approve <id> [--comment "…"]  approve a pending proposal',
      '  reject  <id> [--comment "…"]  reject a pending proposal',
      '  execute <id>                  execute one approved proposal',
      '  execute --all                 execute every approved proposal',
      '',
      'flags:',
      '  --store <path>                proposal store path (default: .ventus/proposals.json)',
      '  --audit-store <path>          audit store path (default: .ventus/audit.json)',
      '  --outbox <path>               mock-executor outbox (default: .ventus/outbox.json)',
      '  --approver <id>               approver id for decisions (default: cli-user)',
      '  --tenant <uuid>               scope list/execute --all to a tenant',
      '  --json                        output JSON instead of human-readable',
      '',
    ].join('\n'),
  );
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
