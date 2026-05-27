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
  it('registers the anthropic provider by default', () => {
    const reg = buildDefaultRuntimeRegistry();
    expect(reg.has('anthropic')).toBe(true);
    expect(reg.providers()).toContain('anthropic');
  });

  it('does NOT register the fake provider (fake is a test fixture, not a production provider)', () => {
    const reg = buildDefaultRuntimeRegistry();
    expect(reg.has('fake')).toBe(false);
  });

  it('does not construct the AnthropicRuntime at build time (factory is lazy)', () => {
    // AnthropicRuntime throws if ANTHROPIC_API_KEY is missing. The default
    // registry must not trigger that until create() is called.
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => buildDefaultRuntimeRegistry()).not.toThrow();
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
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
});
