import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeAgentRuntime,
  RuntimeRegistry,
  registerModelPricing,
  resetPricingForTests,
} from '@ventus/agent-runtime';
import { FileTenantProfileStore } from '@ventus/store';
import { createApp } from '../app.js';
import { resetAppState, setRuntimeRegistryForTests } from '../state.js';
import { readJson } from '../test-helpers.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';
const USER = '00000000-0000-0000-0000-000000000111';
const HEADERS = { 'x-tenant-id': TENANT_A, 'x-user-id': USER };
const ADMIN_HEADERS = { ...HEADERS, 'x-user-role': 'admin' };

interface CoverageEntry {
  source: 'skill' | 'tenant';
  identifier: string;
  provider: string | null;
  model: string;
  priced: boolean;
}
interface CoverageReport {
  entries: CoverageEntry[];
  ok: boolean;
  unpricedCount: number;
}

async function writeSkill(dir: string, name: string, model: string): Promise<void> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const fm = [
    `name: ${name}`,
    'description: test skill',
    'tier: 2',
    'allowed_tools:',
    '  - create_proposal',
    `model: ${model}`,
  ].join('\n');
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${fm}\n---\n\nPrompt.\n`, 'utf8');
}

describe('GET /v1/admin/pricing-coverage', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-admin-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    resetAppState();
    setRuntimeRegistryForTests(null);
    resetPricingForTests();
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
    setRuntimeRegistryForTests(null);
    resetPricingForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 401 without tenant headers when dev shim is off', async () => {
    const prior = process.env.VENTUS_DEV_DEFAULT_TENANT;
    delete process.env.VENTUS_DEV_DEFAULT_TENANT;
    try {
      const res = await app.request('/v1/admin/pricing-coverage');
      expect(res.status).toBe(401);
    } finally {
      if (prior !== undefined) process.env.VENTUS_DEV_DEFAULT_TENANT = prior;
    }
  });

  it('returns 403 to a non-admin member', async () => {
    // Cross-tenant inventory must not be visible to regular members.
    const res = await app.request('/v1/admin/pricing-coverage', { headers: HEADERS });
    expect(res.status).toBe(403);
  });

  it('reports ok=true when every skill model is priced and no tenants override', async () => {
    await writeSkill(dir, 'reply-drafter', 'claude-sonnet-4-6');
    const res = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    expect(res.status).toBe(200);
    const body = await readJson<CoverageReport>(res);
    expect(body.ok).toBe(true);
    expect(body.unpricedCount).toBe(0);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      source: 'skill',
      identifier: 'reply-drafter',
      provider: null,
      model: 'claude-sonnet-4-6',
      priced: true,
    });
  });

  it('reports ok=false when a skill names an unpriced model', async () => {
    // 'mistral-7b' has no entry in the pricing table — it would fall
    // through to the safety fallback and silently miscalibrate the cost
    // ceiling for any tenant that ends up routed through a paid provider.
    await writeSkill(dir, 'odd-skill', 'mistral-7b');
    const res = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    const body = await readJson<CoverageReport>(res);
    expect(body.ok).toBe(false);
    expect(body.unpricedCount).toBe(1);
    expect(body.entries[0]).toMatchObject({
      source: 'skill',
      model: 'mistral-7b',
      priced: false,
    });
  });

  it('marks tenant overrides on a free provider (ollama) as priced regardless of pricing-table entry', async () => {
    // Threat: a tenant on ollama with an exotic model would otherwise show
    // up as a "gap" and block the boot gate, even though no money changes
    // hands. We special-case the free-provider set on the tenant entries.
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(reg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );

    const res = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    const body = await readJson<CoverageReport>(res);
    const tenantEntry = body.entries.find((e) => e.source === 'tenant');
    expect(tenantEntry).toMatchObject({
      source: 'tenant',
      identifier: TENANT_A,
      provider: 'ollama',
      model: 'llama3.1:8b',
      priced: true,
    });
    expect(body.ok).toBe(true);
  });

  it('flags a tenant override on a paid provider whose model is unpriced', async () => {
    // The HIGH-1 / pricing-gate threat scenario in one row: an admin pins
    // the tenant to a provider that bills but selects a model we have no
    // price for. The cost ceiling is unenforceable for this tenant until
    // the operator either registers pricing or repairs the override.
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('openrouter', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(reg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_B,
      { provider: 'openrouter', model: 'qwen/qwen3-72b' },
      { updatedBy: 'admin-1' },
    );

    const res = await app.request('/v1/admin/pricing-coverage', {
      headers: { ...ADMIN_HEADERS, 'x-tenant-id': TENANT_B },
    });
    const body = await readJson<CoverageReport>(res);
    const tenantEntry = body.entries.find((e) => e.source === 'tenant');
    expect(tenantEntry).toMatchObject({
      source: 'tenant',
      identifier: TENANT_B,
      provider: 'openrouter',
      model: 'qwen/qwen3-72b',
      priced: false,
    });
    expect(body.ok).toBe(false);
  });

  it('never returns another tenant\'s runtime override (CODEX HIGH-1)', async () => {
    // Pre-fix bug: a tenant admin could read every other tenant's runtime
    // provider/model via this endpoint because the report was platform-wide
    // and only role-gated. We pin TENANT_B's override and then call as
    // TENANT_A admin — the response must NOT contain TENANT_B.
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('openrouter', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(reg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_B,
      { provider: 'openrouter', model: 'qwen/qwen3-72b' },
      { updatedBy: 'admin-other' },
    );

    const res = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    const body = await readJson<CoverageReport>(res);
    const tenantEntries = body.entries.filter((e) => e.source === 'tenant');
    // TENANT_A has no override; TENANT_B is hidden from TENANT_A's admin.
    expect(tenantEntries).toHaveLength(0);
    for (const e of body.entries) {
      if (e.source === 'tenant') expect(e.identifier).not.toBe(TENANT_B);
    }
  });

  it('becomes ok=true after registering custom pricing for the unpriced model', async () => {
    // Operator workflow: see a gap, register pricing, gate flips green.
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('openrouter', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(reg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'openrouter', model: 'qwen/qwen3-72b' },
      { updatedBy: 'admin-1' },
    );

    const before = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    const beforeBody = await readJson<CoverageReport>(before);
    expect(beforeBody.ok).toBe(false);

    registerModelPricing('qwen/qwen3-72b', {
      inputMicrosPerToken: 1,
      outputMicrosPerToken: 2,
      cacheReadMicrosPerToken: 0,
      cacheWriteMicrosPerToken: 0,
    });

    const after = await app.request('/v1/admin/pricing-coverage', { headers: ADMIN_HEADERS });
    const afterBody = await readJson<CoverageReport>(after);
    expect(afterBody.ok).toBe(true);
    expect(afterBody.unpricedCount).toBe(0);
  });
});

interface DriftEntry {
  tenantId: string;
  provider: string;
  model: string;
  runtimeUpdatedAt?: string;
  runtimeUpdatedBy?: string;
}
interface DriftReport {
  entries: DriftEntry[];
  registeredProviders: string[];
}

describe('GET /v1/admin/runtime-drift', () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ventus-admin-drift-'));
    process.env.VENTUS_SKILLS_DIR = dir;
    process.env.VENTUS_PROPOSAL_STORE = join(dir, 'proposals.json');
    process.env.VENTUS_AUDIT_STORE = join(dir, 'audit.json');
    process.env.VENTUS_OUTBOX = join(dir, 'outbox.json');
    process.env.VENTUS_RUN_STORE = join(dir, 'runs.json');
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
    resetAppState();
    setRuntimeRegistryForTests(null);
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
    setRuntimeRegistryForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 401 without tenant headers when dev shim is off', async () => {
    const prior = process.env.VENTUS_DEV_DEFAULT_TENANT;
    delete process.env.VENTUS_DEV_DEFAULT_TENANT;
    try {
      const res = await app.request('/v1/admin/runtime-drift');
      expect(res.status).toBe(401);
    } finally {
      if (prior !== undefined) process.env.VENTUS_DEV_DEFAULT_TENANT = prior;
    }
  });

  it('returns 403 to a non-admin member', async () => {
    const res = await app.request('/v1/admin/runtime-drift', { headers: HEADERS });
    expect(res.status).toBe(403);
  });

  it('returns an empty list and the registered-provider set when nothing has drifted', async () => {
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(reg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );

    const res = await app.request('/v1/admin/runtime-drift', { headers: ADMIN_HEADERS });
    expect(res.status).toBe(200);
    const body = await readJson<DriftReport>(res);
    expect(body.entries).toEqual([]);
    expect(body.registeredProviders.sort()).toEqual(['anthropic', 'ollama']);
  });

  it('lists tenants whose stored provider is no longer registered', async () => {
    // Drift scenario: at write time the registry had 'ollama'; the env now
    // only has 'anthropic'. Without this report the operator wouldn't know
    // any tenant was about to 503 until a real run came in.
    const driftReg = new RuntimeRegistry();
    driftReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    driftReg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(driftReg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );
    await store.setRuntime(
      TENANT_B,
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { updatedBy: 'admin-2' },
    );

    // Now simulate the env drift: rebuild AppState with a registry that
    // dropped ollama. The state cache reset is what triggers re-bind to
    // the new registry; setRuntimeRegistryForTests already does that.
    const shrunkReg = new RuntimeRegistry();
    shrunkReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    setRuntimeRegistryForTests(shrunkReg);
    app = createApp();

    const res = await app.request('/v1/admin/runtime-drift', { headers: ADMIN_HEADERS });
    const body = await readJson<DriftReport>(res);
    expect(body.registeredProviders).toEqual(['anthropic']);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      tenantId: TENANT_A,
      provider: 'ollama',
      model: 'llama3.1:8b',
      runtimeUpdatedBy: 'admin-1',
    });
    expect(body.entries[0]?.runtimeUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never returns another tenant\'s drift row (CODEX HIGH-1)', async () => {
    // Pre-fix bug: drift report listed every drifted tenant platform-wide.
    // Pin two tenants with drifted providers, call as TENANT_A admin, the
    // response must NOT include TENANT_B's drift row.
    const driftReg = new RuntimeRegistry();
    driftReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    driftReg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(driftReg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );
    await store.setRuntime(
      TENANT_B,
      { provider: 'ollama', model: 'mistral-7b' },
      { updatedBy: 'admin-2' },
    );

    // Drop ollama: both tenants drift, but the caller (TENANT_A) must only
    // see its own row.
    const shrunkReg = new RuntimeRegistry();
    shrunkReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    setRuntimeRegistryForTests(shrunkReg);
    app = createApp();

    const res = await app.request('/v1/admin/runtime-drift', { headers: ADMIN_HEADERS });
    const body = await readJson<DriftReport>(res);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.tenantId).toBe(TENANT_A);
    for (const e of body.entries) expect(e.tenantId).not.toBe(TENANT_B);
  });

  it('drains the drift list after the operator repairs the override', async () => {
    // After-action: operator points the drifted tenant at a still-registered
    // provider; the drift list shrinks back to empty.
    const driftReg = new RuntimeRegistry();
    driftReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    driftReg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'o' }] }));
    setRuntimeRegistryForTests(driftReg);

    const store = new FileTenantProfileStore(process.env.VENTUS_TENANT_PROFILE_STORE!);
    await store.setRuntime(
      TENANT_A,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );

    const shrunkReg = new RuntimeRegistry();
    shrunkReg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    setRuntimeRegistryForTests(shrunkReg);
    app = createApp();

    const drifted = await app.request('/v1/admin/runtime-drift', { headers: ADMIN_HEADERS });
    const driftedBody = await readJson<DriftReport>(drifted);
    expect(driftedBody.entries).toHaveLength(1);

    // Repair: re-point to anthropic.
    await store.setRuntime(
      TENANT_A,
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { updatedBy: 'admin-1' },
    );

    const repaired = await app.request('/v1/admin/runtime-drift', { headers: ADMIN_HEADERS });
    const repairedBody = await readJson<DriftReport>(repaired);
    expect(repairedBody.entries).toEqual([]);
  });
});
