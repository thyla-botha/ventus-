import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { resetAppState } from './state.js';

// Per-test harness: tmpdir for stores + a fresh Hono app + tenant headers.
// Use in beforeEach/afterEach so each test gets isolated file-backed state
// and the singleton in state.ts is rebuilt against the new env paths.

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  dir: string;
  tenantId: string;
  userId: string;
  headers: Record<string, string>;
  // Default headers + x-user-role: admin. Use on PUT/DELETE for admin-gated
  // routes (e.g. /v1/tenant/profile). Reads do not need it.
  adminHeaders: Record<string, string>;
  cleanup(): Promise<void>;
}

export const TEST_TENANT_A = '00000000-0000-0000-0000-00000000000a';
export const TEST_TENANT_B = '00000000-0000-0000-0000-00000000000b';
export const TEST_USER = '00000000-0000-0000-0000-000000000111';

export async function makeHarness(opts: { tenantId?: string; userId?: string } = {}): Promise<TestHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'ventus-api-'));
  process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
  process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
  process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
  process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
  process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
  resetAppState();

  const tenantId = opts.tenantId ?? TEST_TENANT_A;
  const userId = opts.userId ?? TEST_USER;
  const headers = { 'x-tenant-id': tenantId, 'x-user-id': userId };

  return {
    app: createApp(),
    dir,
    tenantId,
    userId,
    headers,
    adminHeaders: { ...headers, 'x-user-role': 'admin' },
    async cleanup() {
      delete process.env.VENTUS_PROPOSAL_STORE;
      delete process.env.VENTUS_AUDIT_STORE;
      delete process.env.VENTUS_OUTBOX;
      delete process.env.VENTUS_RUN_STORE;
      delete process.env.VENTUS_TENANT_PROFILE_STORE;
      resetAppState();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// Convenience: POST a proposal directly into the store, so tests don't need
// a separate "create" endpoint (the agent runtime owns proposal creation).
export async function seedProposal(
  h: TestHarness,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { FileProposalStore } = await import('@ventus/store');
  const store = new FileProposalStore(process.env.VENTUS_PROPOSAL_STORE!);
  const created = await store.create({
    tenantId: h.tenantId,
    runId: 'run-test',
    agentId: 'agent-test',
    actionType: 'draft_email_reply',
    payload: { to: 'a@b.com', subject: 's', body: 'b' },
    ...overrides,
  });
  return created.id;
}

// Typed JSON body. `res.json()` returns Promise<any>, which then propagates
// `unknown` under strict — every test that touches body.field tripped TS18046.
// New tests should use this; old tests can be migrated incrementally.
export async function readJson<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// Convenience: open a Run row directly in the store so /v1/runs tests have
// concrete rows to read without going through the agent loop.
export async function seedRun(
  h: TestHarness,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { FileRunStore } = await import('@ventus/store');
  const store = new FileRunStore(process.env.VENTUS_RUN_STORE!);
  const created = await store.create({
    tenantId: h.tenantId,
    agentId: 'agent-test',
    skillId: 'customer-reply-drafter',
    model: 'claude-sonnet-4-6',
    userMessage: 'draft a reply',
    ...overrides,
  });
  return created.id;
}
