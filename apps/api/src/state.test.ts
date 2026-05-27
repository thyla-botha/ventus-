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
const ENV_KEYS = ['VENTUS_RUNTIME_PROVIDER', 'ANTHROPIC_API_KEY'] as const;

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
