import OpenAI from 'openai';
import {
  OpenAICompatibleRuntime,
  assertSafeHeaderValue,
} from './openai-compatible.js';

// OpenRouter-backed runtime. OpenRouter is OpenAI-compatible at
// https://openrouter.ai/api/v1, so the OpenAI SDK works against it with
// a custom baseURL. One adapter unlocks GPT (4o, 4.1, 5), Claude (via
// OpenRouter), Llama (3.1, 3.3, 4), Qwen, DeepSeek, Mistral, and most
// other open-source models OpenRouter hosts.
//
// All chat-loop logic, content normalization, and security invariants
// live in OpenAICompatibleRuntime — this file only handles the
// constructor (API key, baseURL, OpenRouter-specific dashboard
// attribution headers).
//
// PRICING CAVEAT: `runtime.ts`'s PRICING map is Claude-only today. Costs
// for OpenRouter models fall through to FALLBACK_PRICING, so cost
// ceilings are inaccurate for any non-Claude model. Closing this gap is
// a deferred chunk (see project-deferred-backlog: "Externalize
// pricing"). Until then, set VENTUS_COST_CEILING_MICROS conservatively
// for non-Anthropic runs.

export interface OpenRouterRuntimeOptions {
  apiKey?: string;
  baseURL?: string;
  // Optional headers OpenRouter surfaces in its dashboard so operators
  // can attribute traffic per app. Not required, but useful in
  // multi-tenant ops.
  appName?: string;
  appUrl?: string;
}

export class OpenRouterRuntime extends OpenAICompatibleRuntime {
  readonly provider = 'openrouter';
  protected readonly providerLabel = 'openrouter';

  constructor(opts: OpenRouterRuntimeOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');
    // Reject control characters in header values (CR/LF/NUL) — defence
    // against header-injection if appName/appUrl ever flow from
    // user-controlled config. URL must also parse cleanly.
    if (opts.appUrl !== undefined) {
      assertSafeHeaderValue('appUrl', opts.appUrl);
      try {
        new URL(opts.appUrl);
      } catch {
        throw new Error(
          `OpenRouterRuntime: appUrl is not a valid URL (${opts.appUrl})`,
        );
      }
    }
    if (opts.appName !== undefined) {
      assertSafeHeaderValue('appName', opts.appName);
    }
    super(
      new OpenAI({
        apiKey,
        baseURL: opts.baseURL ?? 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          ...(opts.appUrl ? { 'HTTP-Referer': opts.appUrl } : {}),
          ...(opts.appName ? { 'X-Title': opts.appName } : {}),
        },
      }),
    );
  }
}
