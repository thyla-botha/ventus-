import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAgentRuntime, type AgentRuntime, type RunInput, type RunStepEvent } from '@ventus/agent-runtime';
import type { RunRecord } from '@ventus/store';
import { createApp } from '../app.js';
import { getAppState, resetAppState, setRuntimeForTests } from '../state.js';
import { readJson } from '../test-helpers.js';

// Per-tenant concurrency cap on POST /v1/runs. The cap is read from
// VENTUS_PER_TENANT_RUN_CAP at AppState construction; each request claims a
// slot BEFORE the loop starts and releases it when the loop settles.
//
// The "at cap returns 429" test needs a runtime that holds the loop open so
// the slot stays claimed across multiple requests. HoldingRuntime below blocks
// at step 1 on a controllable promise and finishes when release() is called.

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const USER = '00000000-0000-0000-0000-000000000111';
const HEADERS_A = { 'x-tenant-id': TENANT_A, 'x-user-id': USER };
const HEADERS_B = { 'x-tenant-id': TENANT_B, 'x-user-id': USER };

interface CreateRunBody {
  run: RunRecord;
}
interface ErrorBody {
  error: string;
  cap?: number;
}

class HoldingRuntime implements AgentRuntime {
  readonly provider = 'fake-holding';
  private gates: Array<() => void> = [];
  private waiting: Array<Promise<void>> = [];

  releaseAll(): void {
    for (const g of this.gates) g();
    this.gates = [];
    this.waiting = [];
  }

  async *run(_input: RunInput): AsyncIterable<RunStepEvent> {
    yield { type: 'step_started', stepNo: 1 };
    const wait = new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    this.waiting.push(wait);
    await wait;
    yield {
      type: 'assistant_message',
      content: [{ type: 'text', text: 'done.' }],
      stopReason: 'end_turn',
      costMicros: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    yield { type: 'completed', totalCostMicros: 0, finalText: 'done.', reason: 'end_turn' };
  }
}

async function writeSkill(dir: string, name: string) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const body =
    `---\nname: ${name}\ndescription: drafts replies\ntier: 2\n` +
    `allowed_tools:\n  - create_proposal\nmodel: claude-sonnet-4-6\n---\n\n` +
    `System prompt.\n`;
  await writeFile(join(skillDir, 'SKILL.md'), body, 'utf8');
}

describe('POST /v1/runs — per-tenant concurrency cap', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let holding: HoldingRuntime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-runs-concur-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    // Tight cap so we can prove enforcement with two requests.
    process.env.VENTUS_PER_TENANT_RUN_CAP = '2';
    holding = new HoldingRuntime();
    setRuntimeForTests(holding);
    app = createApp();
    await writeSkill(dir, 'reply-drafter');
  });

  afterEach(async () => {
    // Always release any held loops so drainInflight() can settle.
    holding.releaseAll();
    await getAppState().drainInflight();
    delete process.env.VENTUS_SKILLS_DIR;
    delete process.env.VENTUS_PROPOSAL_STORE;
    delete process.env.VENTUS_AUDIT_STORE;
    delete process.env.VENTUS_OUTBOX;
    delete process.env.VENTUS_RUN_STORE;
    delete process.env.VENTUS_TENANT_PROFILE_STORE;
    delete process.env.VENTUS_PER_TENANT_RUN_CAP;
    setRuntimeForTests(null);
    resetAppState();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 429 once the tenant hits the per-tenant cap', async () => {
    // Cap is 2 (env). Fire two requests that hold the loop open, then the
    // third must overflow before any expensive work (runtime, runs.create).
    const r1 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'a' }),
    });
    expect(r1.status).toBe(202);
    const r2 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'b' }),
    });
    expect(r2.status).toBe(202);

    const r3 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'c' }),
    });
    expect(r3.status).toBe(429);
    const body = await readJson<ErrorBody>(r3);
    expect(body.error).toMatch(/cap/i);
    expect(body.cap).toBe(2);
  });

  it('frees the slot when a run completes', async () => {
    // Fill the cap, then release ONE loop. Slot must free and the next POST
    // must succeed — proves the completion-finally chain actually fires.
    const r1 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'a' }),
    });
    expect(r1.status).toBe(202);
    const r2 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'b' }),
    });
    expect(r2.status).toBe(202);

    // Confirm cap is enforced before we release.
    const overflow = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'c' }),
    });
    expect(overflow.status).toBe(429);

    // Release the held loops and drain. drainInflight resolves only after
    // each loop's completion .finally() — which is where releaseRunSlot
    // fires — so the slot must be free by the time drain returns.
    holding.releaseAll();
    await getAppState().drainInflight();

    // Slot is free, so the next POST gets a new slot.
    const recovered = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'd' }),
    });
    expect(recovered.status).toBe(202);
  });

  it('isolates the cap per tenant (A at cap does not affect B)', async () => {
    // Fill tenant A's cap entirely.
    for (let i = 0; i < 2; i++) {
      const r = await app.request('/v1/runs', {
        method: 'POST',
        headers: { ...HEADERS_A, 'content-type': 'application/json' },
        body: JSON.stringify({ skillName: 'reply-drafter', message: `a${i}` }),
      });
      expect(r.status).toBe(202);
    }
    const overflowA = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'a-overflow' }),
    });
    expect(overflowA.status).toBe(429);

    // Tenant B has its own counter and must be unaffected.
    const b1 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_B, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'b1' }),
    });
    expect(b1.status).toBe(202);
    const b2 = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_B, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'b2' }),
    });
    expect(b2.status).toBe(202);
    const overflowB = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_B, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'b-overflow' }),
    });
    // Tenant B overflows AT ITS OWN cap, not because of tenant A.
    expect(overflowB.status).toBe(429);
  });
});

describe('POST /v1/runs — concurrency cap defaults', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-runs-concur-default-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    // No VENTUS_PER_TENANT_RUN_CAP — exercise the default.
    delete process.env.VENTUS_PER_TENANT_RUN_CAP;
    setRuntimeForTests(new FakeAgentRuntime({ turns: [{ text: 'done.' }] }));
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

  it('releases the slot when getRuntime() throws (error path)', async () => {
    // Defense-in-depth: if runtime construction fails, the claim must still
    // be released or a misconfigured ANTHROPIC_API_KEY would burn cap headroom
    // permanently. Force the throw by clearing the test runtime override and
    // letting AnthropicRuntime construction try (and fail without the env var).
    setRuntimeForTests(null);
    delete process.env.ANTHROPIC_API_KEY;
    const state = getAppState();
    // Cap is 5 by default in this describe block. Make ALL slots claimable
    // first to prove the release fired — fill to N-1, fire failing request,
    // verify we can still claim one (release happened) but not two.
    for (let i = 0; i < 4; i++) {
      expect(state.tryClaimRunSlot(TENANT_A)).toBe(true);
    }
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'go' }),
    });
    expect(res.status).toBe(503);
    // The failing request claimed and released. We should still have exactly
    // 4 slots taken (the manually-claimed ones); the 5th must be free.
    expect(state.tryClaimRunSlot(TENANT_A)).toBe(true);
    expect(state.tryClaimRunSlot(TENANT_A)).toBe(false);
    for (let i = 0; i < 5; i++) state.releaseRunSlot(TENANT_A);
  });

  it('defaults the cap to 5 when VENTUS_PER_TENANT_RUN_CAP is unset', async () => {
    // The default surfaces on the 429 body's `cap` field. Trigger overflow
    // by claiming all 5 slots synchronously before the loops can settle.
    const state = getAppState();
    expect(state.perTenantRunCap).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(state.tryClaimRunSlot(TENANT_A)).toBe(true);
    }
    // 6th claim must fail — and so must a real HTTP request.
    expect(state.tryClaimRunSlot(TENANT_A)).toBe(false);
    const res = await app.request('/v1/runs', {
      method: 'POST',
      headers: { ...HEADERS_A, 'content-type': 'application/json' },
      body: JSON.stringify({ skillName: 'reply-drafter', message: 'go' }),
    });
    expect(res.status).toBe(429);
    const body = await readJson<ErrorBody>(res);
    expect(body.cap).toBe(5);
    // Hand the manually-claimed slots back so afterEach can drain cleanly.
    for (let i = 0; i < 5; i++) state.releaseRunSlot(TENANT_A);
  });
});
