import type { AgentRuntime } from './runtime.js';
import { AnthropicRuntime } from './anthropic.js';
import { OpenRouterRuntime } from './openrouter.js';

// RuntimeRegistry — central seam for picking which AgentRuntime
// implementation backs a run.
//
// Why this exists: the platform must support multiple LLM providers
// (Anthropic today; OpenAI/OpenRouter for GPT-class and open-source models;
// Ollama/vLLM for self-hosted Llama/Qwen/DeepSeek; etc.). Each provider has
// its own SDK shape, but they all satisfy the AgentRuntime interface from
// runtime.ts. The orchestrator (apps/api/src/state.ts) does NOT need to
// know which provider it's calling — it just asks the registry for one.
//
// Factories are lazy: `register(provider, () => new ConcreteRuntime())` does
// not construct anything. `create(provider)` invokes the factory only when a
// run is actually requested. This matters because some runtimes (notably
// AnthropicRuntime) throw on construction if their API key is missing — we
// don't want that to surface at boot for a tenant that's configured for a
// different provider.
//
// Selection is NOT tenant-aware yet. Today the caller passes a provider name
// (typically from env or admin config); per-tenant overrides land in a
// follow-up chunk that extends TenantProfile with a runtime config block.

export type RuntimeFactory = () => AgentRuntime;

// Normalize provider names to a single canonical form. Provider IDs are
// stable machine names (used in audit hashes, run rows, env vars), so we
// trim and lowercase at the registry boundary — that way ' Anthropic ',
// 'anthropic', and 'ANTHROPIC' all resolve to the same factory instead of
// fragmenting into hard-to-diagnose unknown-provider errors. Empty after
// trim throws — there is no useful empty-string provider.
function normalize(provider: string, op: string): string {
  if (typeof provider !== 'string') {
    throw new Error(`RuntimeRegistry.${op}: provider must be a non-empty string`);
  }
  const trimmed = provider.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(`RuntimeRegistry.${op}: provider must be a non-empty string`);
  }
  return trimmed;
}

export class RuntimeRegistry {
  private readonly factories = new Map<string, RuntimeFactory>();

  register(provider: string, factory: RuntimeFactory): this {
    const key = normalize(provider, 'register');
    if (this.factories.has(key)) {
      throw new Error(`RuntimeRegistry: factory already registered for provider=${key}`);
    }
    this.factories.set(key, factory);
    return this;
  }

  // Overwrites an existing registration. Used by tests that want to swap in
  // a fake runtime for a provider already wired by buildDefaultRuntimeRegistry().
  // Production code should prefer register() so accidental shadowing throws.
  override(provider: string, factory: RuntimeFactory): this {
    const key = normalize(provider, 'override');
    this.factories.set(key, factory);
    return this;
  }

  has(provider: string): boolean {
    return this.factories.has(normalize(provider, 'has'));
  }

  // Lists registered provider names alphabetically. Useful for surfacing
  // available providers in admin UIs and error messages.
  providers(): string[] {
    return Array.from(this.factories.keys()).sort();
  }

  // Invokes the factory for `provider` and returns the AgentRuntime. Throws
  // if no factory is registered, listing the available providers so the
  // operator sees what they could have typed instead.
  create(provider: string): AgentRuntime {
    const key = normalize(provider, 'create');
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(
        `RuntimeRegistry: no runtime registered for provider=${key}. ` +
          `Available providers: ${this.providers().join(', ') || '(none)'}`,
      );
    }
    return factory();
  }
}

// Default registry seeded with the providers that ship in this package.
// Today: 'anthropic' only. Open-source / hosted alternatives (OpenRouter,
// Ollama, vLLM, etc.) will register themselves through this function as
// their adapters land in subsequent chunks.
//
// FakeAgentRuntime is intentionally NOT registered here — it's a test
// fixture, not a production provider. Tests that need it should
// construct their own registry or call .override('fake', ...).
export function buildDefaultRuntimeRegistry(): RuntimeRegistry {
  const reg = new RuntimeRegistry();
  reg.register('anthropic', () => new AnthropicRuntime());
  reg.register('openrouter', () => new OpenRouterRuntime());
  return reg;
}
