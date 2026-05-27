import OpenAI from 'openai';
import { OpenAICompatibleRuntime } from './openai-compatible.js';

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
// local inference, so VENTUS_COST_CEILING_MICROS becomes moot in
// monetary terms — but the ceiling still works as a runaway-loop guard
// rail because totalCostMicros grows by 0 each step and never trips,
// meaning operators relying on it for loop bounds should use
// `maxSteps` instead. (Documented here so nobody mistakes this for a
// reliable cost cap on local runs.)
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
}
