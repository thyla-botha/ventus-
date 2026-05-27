import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeAgentRuntime,
  RuntimeRegistry,
  type AgentRuntime,
} from '@ventus/agent-runtime';
import {
  getAppState,
  resetAppState,
  setRuntimeForTests,
  setRuntimeRegistryForTests,
} from './state.js';

// Snapshot env we touch so cases can mutate freely and restore on teardown.
const ENV_KEYS = [
  'VENTUS_RUNTIME_PROVIDER',
  'ANTHROPIC_API_KEY',
  'VENTUS_TENANT_PROFILE_STORE',
  'VENTUS_DEV_FAKE_RUNTIME',
] as const;

const TEST_TENANT = 'tenant-A';

describe('AppState runtime selection', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
  });

  it('uses the runtimeOverride when set (legacy test seam still works)', () => {
    const fake = new FakeAgentRuntime({ turns: [{ text: 'override' }] });
    setRuntimeForTests(fake);
    const runtime = getAppState().getRuntime();
    expect(runtime).toBe(fake);
  });

  it('selects the registry-default provider when VENTUS_RUNTIME_PROVIDER is unset (anthropic)', () => {
    // Use a custom registry so we don't actually instantiate AnthropicRuntime
    // (which would require ANTHROPIC_API_KEY). The point of this test is to
    // confirm 'anthropic' is the resolved provider name, not the SDK shape.
    const reg = new RuntimeRegistry();
    const marker = new FakeAgentRuntime({ turns: [{ text: 'anthropic-stand-in' }] });
    reg.register('anthropic', () => marker);
    setRuntimeRegistryForTests(reg);
    delete process.env.VENTUS_RUNTIME_PROVIDER;
    const runtime = getAppState().getRuntime();
    expect(runtime).toBe(marker);
  });

  it('selects the provider named in VENTUS_RUNTIME_PROVIDER', () => {
    const reg = new RuntimeRegistry();
    const a = new FakeAgentRuntime({ turns: [{ text: 'a' }] });
    const b = new FakeAgentRuntime({ turns: [{ text: 'b' }] });
    reg.register('anthropic', () => a);
    reg.register('experimental', () => b);
    setRuntimeRegistryForTests(reg);

    process.env.VENTUS_RUNTIME_PROVIDER = 'experimental';
    const runtime = getAppState().getRuntime();
    expect(runtime).toBe(b);
  });

  it('throws a helpful error when VENTUS_RUNTIME_PROVIDER names an unregistered provider', () => {
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'x' }] }));
    setRuntimeRegistryForTests(reg);
    process.env.VENTUS_RUNTIME_PROVIDER = 'nonsense';

    expect(() => getAppState().getRuntime()).toThrow(/provider=nonsense/);
    expect(() => getAppState().getRuntime()).toThrow(/Available providers: anthropic/);
  });

  it('treats blank VENTUS_RUNTIME_PROVIDER as unset (falls back to anthropic)', () => {
    const reg = new RuntimeRegistry();
    const marker = new FakeAgentRuntime({ turns: [{ text: 'anthropic' }] });
    reg.register('anthropic', () => marker);
    setRuntimeRegistryForTests(reg);
    process.env.VENTUS_RUNTIME_PROVIDER = '   ';
    const runtime = getAppState().getRuntime();
    expect(runtime).toBe(marker);
  });

  it('invokes the factory lazily — registry construction does not instantiate any runtime', () => {
    // Per the AppState docstring: AnthropicRuntime throws on construction
    // without ANTHROPIC_API_KEY. The registry/AppState wiring must not trip
    // that until getRuntime() is actually called.
    delete process.env.ANTHROPIC_API_KEY;
    let constructed = 0;
    const reg = new RuntimeRegistry();
    reg.register('anthropic', (): AgentRuntime => {
      constructed += 1;
      return new FakeAgentRuntime({ turns: [{ text: 'ok' }] });
    });
    setRuntimeRegistryForTests(reg);

    // Building AppState alone must not construct the runtime.
    getAppState();
    expect(constructed).toBe(0);

    // Only the actual getRuntime() call triggers construction.
    getAppState().getRuntime();
    expect(constructed).toBe(1);
  });
});

describe('AppState.resolveRuntimeForTenant', () => {
  let snapshot: Record<string, string | undefined>;
  let dir: string;

  beforeEach(async () => {
    snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
    dir = await mkdtemp(join(tmpdir(), 'ventus-state-'));
    process.env.VENTUS_TENANT_PROFILE_STORE = join(dir, 'tenant-profiles.json');
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the deployment default when the tenant has no profile', async () => {
    const reg = new RuntimeRegistry();
    const def = new FakeAgentRuntime({ turns: [{ text: 'default' }] });
    reg.register('anthropic', () => def);
    setRuntimeRegistryForTests(reg);

    const resolved = await getAppState().resolveRuntimeForTenant(TEST_TENANT);
    expect(resolved.runtime).toBe(def);
    expect(resolved.modelOverride).toBeUndefined();
  });

  it('uses the tenant override and returns modelOverride when provider is registered', async () => {
    const reg = new RuntimeRegistry();
    const def = new FakeAgentRuntime({ turns: [{ text: 'def' }] });
    const ollama = new FakeAgentRuntime({ turns: [{ text: 'ollama-stand-in' }] });
    reg.register('anthropic', () => def);
    reg.register('ollama', () => ollama);
    setRuntimeRegistryForTests(reg);

    const state = getAppState();
    await state.tenantProfiles.setRuntime(
      TEST_TENANT,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );

    const resolved = await state.resolveRuntimeForTenant(TEST_TENANT);
    expect(resolved.runtime).toBe(ollama);
    expect(resolved.modelOverride).toBe('llama3.1:8b');
  });

  it('falls back to the deployment default when the tenant override names an unregistered provider', async () => {
    const reg = new RuntimeRegistry();
    const def = new FakeAgentRuntime({ turns: [{ text: 'default' }] });
    reg.register('anthropic', () => def);
    setRuntimeRegistryForTests(reg);

    const state = getAppState();
    // Seed a profile with a stale provider directly via the store so we
    // can simulate "tenant was configured for provider X, then env dropped X"
    // (write-time validation would normally block this, but the read path
    // must still degrade gracefully).
    await state.tenantProfiles.setRuntime(
      TEST_TENANT,
      { provider: 'experimental', model: 'gpt-future' },
      { updatedBy: 'admin-1' },
    );

    const resolved = await state.resolveRuntimeForTenant(TEST_TENANT);
    expect(resolved.runtime).toBe(def);
    expect(resolved.modelOverride).toBeUndefined();
  });

  it('runtimeOverride short-circuits the tenant lookup (test fixtures win)', async () => {
    const reg = new RuntimeRegistry();
    const ollama = new FakeAgentRuntime({ turns: [{ text: 'ollama' }] });
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'a' }] }));
    reg.register('ollama', () => ollama);
    setRuntimeRegistryForTests(reg);

    const fixture = new FakeAgentRuntime({ turns: [{ text: 'fixture' }] });
    setRuntimeForTests(fixture);

    const state = getAppState();
    await state.tenantProfiles.setRuntime(
      TEST_TENANT,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { updatedBy: 'admin-1' },
    );

    const resolved = await state.resolveRuntimeForTenant(TEST_TENANT);
    expect(resolved.runtime).toBe(fixture);
    expect(resolved.modelOverride).toBeUndefined();
  });
});

describe('AppState.hasRuntimeProvider', () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = snapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAppState();
    setRuntimeForTests(null);
    setRuntimeRegistryForTests(null);
  });

  it('reflects the registered providers', () => {
    const reg = new RuntimeRegistry();
    reg.register('anthropic', () => new FakeAgentRuntime({ turns: [{ text: 'x' }] }));
    reg.register('ollama', () => new FakeAgentRuntime({ turns: [{ text: 'y' }] }));
    setRuntimeRegistryForTests(reg);
    const state = getAppState();
    expect(state.hasRuntimeProvider('anthropic')).toBe(true);
    expect(state.hasRuntimeProvider('ollama')).toBe(true);
    expect(state.hasRuntimeProvider('nonsense')).toBe(false);
    expect(state.listRuntimeProviders().sort()).toEqual(['anthropic', 'ollama']);
  });
});
