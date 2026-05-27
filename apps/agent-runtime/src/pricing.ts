// Model pricing — micros-per-token rates for the cost-ceiling guard.
//
// The cost ceiling (`costCeilingMicros` on RunInput) is a security control:
// it caps how much one run can spend so a stuck/looping agent can't burn
// through a tenant's budget. The ceiling is only useful if the per-token
// rate is approximately correct. Falling through to the wrong rate makes
// the ceiling fire too late (operator pays for the gap) or too early
// (legitimate runs killed). So this module:
//
//   1. Ships a built-in catalog of common models (Claude + popular cloud
//      models via OpenRouter pricing).
//   2. Lets operators register/override prices at runtime —
//      `registerModelPricing()` + `setFallbackPricing()`. Use these at
//      boot to load tenant-specific enterprise rates or models not in the
//      built-in catalog.
//   3. Defaults the fallback to Opus pricing (the priciest Claude tier)
//      so unknown models trip the ceiling SOONER, not later. This errs
//      on the safe side: a too-eager ceiling can be raised; a too-loose
//      ceiling means real money is gone before the operator notices.
//
// **Accuracy disclaimer:** the built-in rates are approximations sourced
// from public pricing pages and are NOT invoicing-grade. Production
// deployments should call `registerModelPricing()` with rates straight
// from their provider's billing dashboard. Provider pricing changes
// frequently — treat the built-ins as a sane default, not a contract.

export interface ModelPricing {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
  // Cached input tokens (where supported, e.g. Anthropic prompt caching,
  // OpenAI prompt caching). Falls through to inputMicrosPerToken if a
  // provider doesn't surface cache token counts.
  cacheReadMicrosPerToken: number;
  cacheWriteMicrosPerToken: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// Built-in catalog. Keys are the model identifiers the orchestrator
// passes to AgentRuntime.run(input.model). For OpenRouter routes the key
// includes the route prefix ('openai/gpt-4o'). For direct Anthropic
// routes the key is the bare model ID ('claude-opus-4-7').
//
// Cache pricing convention follows Anthropic's published ratios at time
// of writing: cache-read is ~10% of standard input, cache-write is
// ~1.25x standard input. For providers without separate cache pricing
// the ratios are still useful as a defensive estimate.
const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // Anthropic — direct
  'claude-opus-4-7': {
    inputMicrosPerToken: 15,
    outputMicrosPerToken: 75,
    cacheReadMicrosPerToken: 1.5,
    cacheWriteMicrosPerToken: 18.75,
  },
  'claude-sonnet-4-6': {
    inputMicrosPerToken: 3,
    outputMicrosPerToken: 15,
    cacheReadMicrosPerToken: 0.3,
    cacheWriteMicrosPerToken: 3.75,
  },
  'claude-haiku-4-5-20251001': {
    inputMicrosPerToken: 1,
    outputMicrosPerToken: 5,
    cacheReadMicrosPerToken: 0.1,
    cacheWriteMicrosPerToken: 1.25,
  },

  // OpenAI — via OpenRouter routes
  'openai/gpt-4o': {
    inputMicrosPerToken: 2.5,
    outputMicrosPerToken: 10,
    cacheReadMicrosPerToken: 1.25,
    cacheWriteMicrosPerToken: 2.5,
  },
  'openai/gpt-4o-mini': {
    inputMicrosPerToken: 0.15,
    outputMicrosPerToken: 0.6,
    cacheReadMicrosPerToken: 0.075,
    cacheWriteMicrosPerToken: 0.15,
  },
  'openai/gpt-4.1': {
    inputMicrosPerToken: 2,
    outputMicrosPerToken: 8,
    cacheReadMicrosPerToken: 0.5,
    cacheWriteMicrosPerToken: 2,
  },
  'openai/gpt-5': {
    inputMicrosPerToken: 1.25,
    outputMicrosPerToken: 10,
    cacheReadMicrosPerToken: 0.125,
    cacheWriteMicrosPerToken: 1.25,
  },

  // Open-source via OpenRouter (rates dynamic; treat as conservative)
  'meta-llama/llama-3.3-70b-instruct': {
    inputMicrosPerToken: 0.23,
    outputMicrosPerToken: 0.4,
    cacheReadMicrosPerToken: 0.115,
    cacheWriteMicrosPerToken: 0.23,
  },
  'meta-llama/llama-3.1-405b-instruct': {
    inputMicrosPerToken: 0.8,
    outputMicrosPerToken: 0.8,
    cacheReadMicrosPerToken: 0.4,
    cacheWriteMicrosPerToken: 0.8,
  },
  'qwen/qwen-2.5-72b-instruct': {
    inputMicrosPerToken: 0.35,
    outputMicrosPerToken: 0.4,
    cacheReadMicrosPerToken: 0.175,
    cacheWriteMicrosPerToken: 0.35,
  },
  'deepseek/deepseek-chat': {
    inputMicrosPerToken: 0.14,
    outputMicrosPerToken: 0.28,
    cacheReadMicrosPerToken: 0.07,
    cacheWriteMicrosPerToken: 0.14,
  },
  'mistralai/mistral-large': {
    inputMicrosPerToken: 2,
    outputMicrosPerToken: 6,
    cacheReadMicrosPerToken: 1,
    cacheWriteMicrosPerToken: 2,
  },
};

// Operator-supplied overrides. Checked before BUILTIN so an operator
// can correct any built-in entry (or add a brand-new model) without
// forking the package.
const CUSTOM_PRICING: Record<string, ModelPricing> = {};

// Conservative fallback: Opus rate by default. An unknown model with no
// registered price trips the cost ceiling EARLIER than reality — operator
// sees the gap and registers the right rate, instead of paying for
// silent under-billing.
let fallbackPricing: ModelPricing = BUILTIN_PRICING['claude-opus-4-7']!;

// Sanity cap on per-token rates. 10_000 micros = 1 cent per token, which
// is already ~50x the priciest current model (Opus output @ 75 micros).
// Operators with custom enterprise contracts pricier than this should
// adjust the cap. The cap exists so an operator pasting `1e9` from a
// typo can't silently install a rate that makes `usageToMicros` overflow
// or trip the cost ceiling on the first input token. Codex round-9 HIGH.
const MAX_MICROS_PER_TOKEN = 10_000;

// Validate a ModelPricing payload: every field must be a finite,
// non-negative, in-range number. `NaN`, `Infinity`, negative, or absurdly
// large rates would silently corrupt cost accounting and defeat the
// cost-ceiling security guarantee. Caller is identified for clearer
// error messages (registerModelPricing vs setFallbackPricing).
function assertValidPricing(p: ModelPricing, caller: string): void {
  if (!p || typeof p !== 'object') {
    throw new Error(`${caller}: pricing must be an object`);
  }
  const fields: (keyof ModelPricing)[] = [
    'inputMicrosPerToken',
    'outputMicrosPerToken',
    'cacheReadMicrosPerToken',
    'cacheWriteMicrosPerToken',
  ];
  for (const f of fields) {
    const v = p[f];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(
        `${caller}: pricing.${f} must be a finite number (got ${String(v)})`,
      );
    }
    if (v < 0) {
      throw new Error(`${caller}: pricing.${f} must be >= 0 (got ${v})`);
    }
    if (v > MAX_MICROS_PER_TOKEN) {
      throw new Error(
        `${caller}: pricing.${f}=${v} exceeds sanity cap ${MAX_MICROS_PER_TOKEN} ` +
          `micros/token. If this is intentional, raise the cap explicitly.`,
      );
    }
  }
}

export function registerModelPricing(
  model: string,
  pricing: ModelPricing,
): void {
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new Error('registerModelPricing: model must be a non-empty string');
  }
  assertValidPricing(pricing, 'registerModelPricing');
  CUSTOM_PRICING[model] = pricing;
}

export function unregisterModelPricing(model: string): void {
  delete CUSTOM_PRICING[model];
}

export function setFallbackPricing(pricing: ModelPricing): void {
  assertValidPricing(pricing, 'setFallbackPricing');
  fallbackPricing = pricing;
}

export function getFallbackPricing(): ModelPricing {
  return fallbackPricing;
}

// Reset operator overrides + fallback. Tests use this; production code
// shouldn't need to (overrides should be set once at boot).
export function resetPricingForTests(): void {
  for (const k of Object.keys(CUSTOM_PRICING)) delete CUSTOM_PRICING[k];
  fallbackPricing = BUILTIN_PRICING['claude-opus-4-7']!;
}

// Returns true iff a price is registered (custom or built-in) for this
// model. Useful for boot-time validation: an operator can iterate
// configured models and refuse to start if any would fall through to
// the safety fallback.
export function hasModelPricing(model: string): boolean {
  return model in CUSTOM_PRICING || model in BUILTIN_PRICING;
}

export function priceForModel(model: string): ModelPricing {
  return CUSTOM_PRICING[model] ?? BUILTIN_PRICING[model] ?? fallbackPricing;
}

// Pricing-coverage report. `priced` is the subset of input models that
// have an explicit entry (custom OR built-in); `unpriced` would fall
// through to the safety fallback if invoked. Operators use this to
// decide whether the cost ceiling is calibrated for their deployment.
//
// Deduplicates on input — a model named twice (e.g. two skills using
// the same backing model) is checked once and reported once. Empty
// strings are filtered out defensively (the orchestrator already
// validates model strings upstream, but a stray '' here would otherwise
// surface as a spurious "unpriced" entry).
export interface PricingCoverageReport {
  priced: string[];
  unpriced: string[];
}

export function validatePricingCoverage(
  models: readonly string[],
): PricingCoverageReport {
  const unique = Array.from(
    new Set(models.filter((m): m is string => typeof m === 'string' && m.length > 0)),
  ).sort();
  const priced: string[] = [];
  const unpriced: string[] = [];
  for (const model of unique) {
    if (hasModelPricing(model)) priced.push(model);
    else unpriced.push(model);
  }
  return { priced, unpriced };
}

export function usageToMicros(model: string, usage: TokenUsage): number {
  const p = priceForModel(model);
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const rawInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return Math.round(
    rawInput * p.inputMicrosPerToken +
      usage.outputTokens * p.outputMicrosPerToken +
      cacheRead * p.cacheReadMicrosPerToken +
      cacheWrite * p.cacheWriteMicrosPerToken,
  );
}
