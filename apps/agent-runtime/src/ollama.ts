import OpenAI from 'openai';
import { OpenAICompatibleRuntime } from './openai-compatible.js';
import type { TokenUsage } from './pricing.js';

// OllamaRuntime — self-hosted / air-gapped inference.
//
// Targets Ollama's OpenAI-compatible chat endpoint at
// {baseURL}/chat/completions (default http://localhost:11434/v1). Closes
// the "open-source models" gap for tenants with data-residency
// constraints — keeps inference inside the trust boundary. Regulated
// mid-market (real estate, forex brokers) is Ventus's primary market;
// some of those tenants will not be allowed to send prompts to a third
// party at all.
//
// Differences from OpenRouter / generic OpenAI:
//   - No API key required. Ollama doesn't authenticate by default. The
//     OpenAI SDK demands a non-empty apiKey, so we send the documented
//     placeholder "ollama".
//   - baseURL defaults to localhost; override via OLLAMA_BASE_URL for a
//     non-default host (e.g. a dedicated GPU box on the LAN).
//   - No app-identification headers (Ollama doesn't surface them).
//
// Cost-ceiling semantics: Ollama's /v1/chat/completions returns the
// `usage` object (prompt_tokens + completion_tokens), so the base
// class's strict usage check still applies. Cost-per-token is zero for
// local inference, so this runtime overrides `computeCostMicros` to
// return 0 — preventing the wildly-wrong global pricing fallback from
// scoring a free local run as if it were Opus traffic. Operators who
// need to budget against compute-time on a paid cluster should subclass
// OllamaRuntime and override computeCostMicros with their own formula.
//
// One consequence: VENTUS_COST_CEILING_MICROS never trips on a pure
// Ollama run. Use `maxSteps` as the runaway-loop guard rail instead.
//
// Model naming: pass tags like 'llama3.3:70b', 'qwen2.5:14b',
// 'deepseek-r1:32b'. Whatever `ollama list` shows.

export interface OllamaRuntimeOptions {
  baseURL?: string;
  // Optional. Defaults to 'ollama' placeholder (Ollama's documented
  // convention). Useful only if a reverse proxy in front of Ollama
  // enforces auth.
  apiKey?: string;
}

export class OllamaRuntime extends OpenAICompatibleRuntime {
  readonly provider = 'ollama';
  protected readonly providerLabel = 'ollama';

  constructor(opts: OllamaRuntimeOptions = {}) {
    const baseURL =
      opts.baseURL ??
      process.env.OLLAMA_BASE_URL ??
      'http://localhost:11434/v1';
    const apiKey =
      opts.apiKey ?? process.env.OLLAMA_API_KEY ?? 'ollama';
    super(new OpenAI({ apiKey, baseURL }));
  }

  // Local inference is free. Returning 0 here keeps the cost-ceiling
  // accounting honest — without this, `usageToMicros` would fall through
  // to the global Opus-rate fallback and score every local turn as if it
  // had cost real money.
  protected override computeCostMicros(_model: string, _usage: TokenUsage): number {
    return 0;
  }
}
