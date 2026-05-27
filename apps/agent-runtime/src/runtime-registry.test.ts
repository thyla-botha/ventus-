import { describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from './fake-runtime.js';
import {
  RuntimeRegistry,
  buildDefaultRuntimeRegistry,
} from './runtime-registry.js';

const fakeFactory = () => new FakeAgentRuntime({ turns: [{ text: 'ok' }] });

describe('RuntimeRegistry', () => {
  describe('register / has / providers', () => {
    it('registers a factory under a provider name', () => {
      const reg = new RuntimeRegistry();
      reg.register('fake', fakeFactory);
      expect(reg.has('fake')).toBe(true);
      expect(reg.providers()).toEqual(['fake']);
    });

    it('returns this from register for chaining', () => {
      const reg = new RuntimeRegistry();
      expect(reg.register('a', fakeFactory)).toBe(reg);
    });

    it('throws on duplicate registration', () => {
      const reg = new RuntimeRegistry();
      reg.register('fake', fakeFactory);
      expect(() => reg.register('fake', fakeFactory)).toThrow(/already registered/);
    });

    it('rejects empty provider name', () => {
      const reg = new RuntimeRegistry();
      expect(() => reg.register('', fakeFactory)).toThrow(/non-empty string/);
    });

    it('rejects whitespace-only provider name', () => {
      const reg = new RuntimeRegistry();
      expect(() => reg.register('   ', fakeFactory)).toThrow(/non-empty string/);
    });

    it('normalizes provider name (trim + lowercase) so case/whitespace variants resolve to the same factory', () => {
      const reg = new RuntimeRegistry();
      reg.register(' Anthropic ', fakeFactory);
      expect(reg.has('anthropic')).toBe(true);
      expect(reg.has('ANTHROPIC')).toBe(true);
      expect(reg.providers()).toEqual(['anthropic']);
      expect(() => reg.create('anthropic')).not.toThrow();
      expect(() => reg.create('  ANTHROPIC  ')).not.toThrow();
    });

    it('treats case/whitespace variants as duplicate registrations', () => {
      const reg = new RuntimeRegistry();
      reg.register('anthropic', fakeFactory);
      expect(() => reg.register(' Anthropic ', fakeFactory)).toThrow(/already registered/);
    });

    it('lists providers alphabetically', () => {
      const reg = new RuntimeRegistry();
      reg.register('zeta', fakeFactory);
      reg.register('alpha', fakeFactory);
      reg.register('mu', fakeFactory);
      expect(reg.providers()).toEqual(['alpha', 'mu', 'zeta']);
    });
  });

  describe('override', () => {
    it('replaces an existing factory without throwing', () => {
      const reg = new RuntimeRegistry();
      const first = vi.fn(fakeFactory);
      const second = vi.fn(fakeFactory);
      reg.register('fake', first);
      reg.override('fake', second);
      reg.create('fake');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('rejects empty provider name', () => {
      const reg = new RuntimeRegistry();
      expect(() => reg.override('', fakeFactory)).toThrow(/non-empty string/);
    });
  });

  describe('create', () => {
    it('invokes the factory lazily (not at registration time)', () => {
      const reg = new RuntimeRegistry();
      const factory = vi.fn(fakeFactory);
      reg.register('fake', factory);
      expect(factory).not.toHaveBeenCalled();
      reg.create('fake');
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('returns a fresh runtime on each call (no caching by the registry)', () => {
      const reg = new RuntimeRegistry();
      reg.register('fake', fakeFactory);
      const a = reg.create('fake');
      const b = reg.create('fake');
      expect(a).not.toBe(b);
    });

    it('throws with the available provider list when provider is unknown', () => {
      const reg = new RuntimeRegistry();
      reg.register('fake', fakeFactory);
      reg.register('other', fakeFactory);
      expect(() => reg.create('mystery')).toThrow(/provider=mystery/);
      expect(() => reg.create('mystery')).toThrow(/fake, other/);
    });

    it('error message lists "(none)" when no providers are registered', () => {
      const reg = new RuntimeRegistry();
      expect(() => reg.create('whatever')).toThrow(/\(none\)/);
    });

    it('propagates errors thrown by the factory (e.g. missing API key)', () => {
      const reg = new RuntimeRegistry();
      reg.register('boom', () => {
        throw new Error('API_KEY not set');
      });
      expect(() => reg.create('boom')).toThrow(/API_KEY not set/);
    });
  });
});

describe('buildDefaultRuntimeRegistry', () => {
  it('registers anthropic, ollama, and openrouter providers by default', () => {
    const reg = buildDefaultRuntimeRegistry();
    expect(reg.has('anthropic')).toBe(true);
    expect(reg.has('ollama')).toBe(true);
    expect(reg.has('openrouter')).toBe(true);
    expect(reg.providers()).toEqual(['anthropic', 'ollama', 'openrouter']);
  });

  it('does NOT register the fake provider (fake is a test fixture, not a production provider)', () => {
    const reg = buildDefaultRuntimeRegistry();
    expect(reg.has('fake')).toBe(false);
  });

  it('does not construct provider runtimes at build time (factories are lazy)', () => {
    // AnthropicRuntime and OpenRouterRuntime each throw if their API key env
    // is missing. The default registry must not trigger that until create()
    // is called — otherwise a tenant configured for one provider would crash
    // the process at boot because another provider's key is unset.
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    const prevOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => buildDefaultRuntimeRegistry()).not.toThrow();
    } finally {
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
      if (prevOpenRouter !== undefined) process.env.OPENROUTER_API_KEY = prevOpenRouter;
    }
  });

  it('anthropic factory throws lazily when API key is missing', () => {
    const reg = buildDefaultRuntimeRegistry();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => reg.create('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('openrouter factory throws lazily when API key is missing', () => {
    const reg = buildDefaultRuntimeRegistry();
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => reg.create('openrouter')).toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it('ollama factory does NOT require an API key (uses "ollama" placeholder)', () => {
    // Ollama doesn't authenticate by default; the runtime must construct
    // without env vars set so a tenant configured for ollama can run on a
    // fresh machine. The OpenAI SDK requires a non-empty apiKey, so the
    // adapter supplies the documented placeholder string.
    const reg = buildDefaultRuntimeRegistry();
    const prevKey = process.env.OLLAMA_API_KEY;
    const prevUrl = process.env.OLLAMA_BASE_URL;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.OLLAMA_BASE_URL;
    try {
      expect(() => reg.create('ollama')).not.toThrow();
    } finally {
      if (prevKey !== undefined) process.env.OLLAMA_API_KEY = prevKey;
      if (prevUrl !== undefined) process.env.OLLAMA_BASE_URL = prevUrl;
    }
  });
});
