import { afterEach, describe, expect, it } from 'vitest';
import {
  getFallbackPricing,
  hasModelPricing,
  priceForModel,
  registerModelPricing,
  resetPricingForTests,
  setFallbackPricing,
  unregisterModelPricing,
  usageToMicros,
  type ModelPricing,
} from './pricing.js';

const TEST_PRICING: ModelPricing = {
  inputMicrosPerToken: 100,
  outputMicrosPerToken: 200,
  cacheReadMicrosPerToken: 10,
  cacheWriteMicrosPerToken: 150,
};

describe('pricing', () => {
  afterEach(() => {
    resetPricingForTests();
  });

  describe('built-in catalog', () => {
    it('covers the three Anthropic tiers (opus, sonnet, haiku)', () => {
      expect(hasModelPricing('claude-opus-4-7')).toBe(true);
      expect(hasModelPricing('claude-sonnet-4-6')).toBe(true);
      expect(hasModelPricing('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('covers common OpenAI routes via OpenRouter', () => {
      expect(hasModelPricing('openai/gpt-4o')).toBe(true);
      expect(hasModelPricing('openai/gpt-4o-mini')).toBe(true);
      expect(hasModelPricing('openai/gpt-4.1')).toBe(true);
    });

    it('covers popular open-source models via OpenRouter', () => {
      expect(hasModelPricing('meta-llama/llama-3.3-70b-instruct')).toBe(true);
      expect(hasModelPricing('qwen/qwen-2.5-72b-instruct')).toBe(true);
      expect(hasModelPricing('deepseek/deepseek-chat')).toBe(true);
    });

    it('reports false for unknown models (no implicit registration)', () => {
      expect(hasModelPricing('some/never-shipped-model-9000')).toBe(false);
    });

    it('GPT-4o output rate matches its input/output asymmetry (output > input)', () => {
      // Smoke test: catches a copy-paste bug where input and output columns
      // got swapped. Output is always strictly more expensive than input on
      // OpenAI's published rates.
      const p = priceForModel('openai/gpt-4o');
      expect(p.outputMicrosPerToken).toBeGreaterThan(p.inputMicrosPerToken);
    });

    it('Opus is more expensive than Haiku on both axes', () => {
      const opus = priceForModel('claude-opus-4-7');
      const haiku = priceForModel('claude-haiku-4-5-20251001');
      expect(opus.inputMicrosPerToken).toBeGreaterThan(haiku.inputMicrosPerToken);
      expect(opus.outputMicrosPerToken).toBeGreaterThan(haiku.outputMicrosPerToken);
    });
  });

  describe('fallback', () => {
    it('defaults to Opus pricing — conservative so unknown models trip ceilings sooner', () => {
      const fb = getFallbackPricing();
      const opus = priceForModel('claude-opus-4-7');
      expect(fb).toEqual(opus);
    });

    it('an unknown model resolves to the fallback', () => {
      const unknown = priceForModel('some/never-shipped-model-9000');
      expect(unknown).toEqual(getFallbackPricing());
    });

    it('setFallbackPricing changes the rate used for unknown models', () => {
      setFallbackPricing(TEST_PRICING);
      expect(getFallbackPricing()).toEqual(TEST_PRICING);
      expect(priceForModel('still/unknown')).toEqual(TEST_PRICING);
    });
  });

  describe('registerModelPricing / overrides', () => {
    it('registers a brand-new model', () => {
      expect(hasModelPricing('acme/super-model')).toBe(false);
      registerModelPricing('acme/super-model', TEST_PRICING);
      expect(hasModelPricing('acme/super-model')).toBe(true);
      expect(priceForModel('acme/super-model')).toEqual(TEST_PRICING);
    });

    it('overrides a built-in entry without mutating the built-in (reset restores it)', () => {
      const original = priceForModel('openai/gpt-4o');
      registerModelPricing('openai/gpt-4o', TEST_PRICING);
      expect(priceForModel('openai/gpt-4o')).toEqual(TEST_PRICING);
      resetPricingForTests();
      expect(priceForModel('openai/gpt-4o')).toEqual(original);
    });

    it('unregisterModelPricing reverts to the built-in price', () => {
      const original = priceForModel('openai/gpt-4o');
      registerModelPricing('openai/gpt-4o', TEST_PRICING);
      unregisterModelPricing('openai/gpt-4o');
      expect(priceForModel('openai/gpt-4o')).toEqual(original);
    });

    it('unregisterModelPricing of a never-registered key is a no-op (no throw)', () => {
      expect(() => unregisterModelPricing('never/seen')).not.toThrow();
    });

    it('rejects empty/whitespace model names — caller bug', () => {
      expect(() => registerModelPricing('', TEST_PRICING)).toThrow(/non-empty string/);
      expect(() => registerModelPricing('   ', TEST_PRICING)).toThrow(/non-empty string/);
    });
  });

  describe('usageToMicros', () => {
    it('computes input + output cost using the registered rate', () => {
      registerModelPricing('test-model', TEST_PRICING);
      const micros = usageToMicros('test-model', {
        inputTokens: 100,
        outputTokens: 50,
      });
      // 100 * 100 + 50 * 200 = 10000 + 10000 = 20000
      expect(micros).toBe(20000);
    });

    it('splits cache-read tokens out of input and bills them at the cache-read rate', () => {
      registerModelPricing('test-model', TEST_PRICING);
      const micros = usageToMicros('test-model', {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadInputTokens: 80,
      });
      // raw input = 100 - 80 = 20 → 20 * 100 = 2000
      // cache read = 80 → 80 * 10 = 800
      // total = 2800
      expect(micros).toBe(2800);
    });

    it('splits cache-creation tokens out of input and bills them at the cache-write rate', () => {
      registerModelPricing('test-model', TEST_PRICING);
      const micros = usageToMicros('test-model', {
        inputTokens: 100,
        outputTokens: 0,
        cacheCreationInputTokens: 40,
      });
      // raw input = 100 - 40 = 60 → 60 * 100 = 6000
      // cache write = 40 → 40 * 150 = 6000
      // total = 12000
      expect(micros).toBe(12000);
    });

    it('handles cache-read + cache-write together without double-billing', () => {
      registerModelPricing('test-model', TEST_PRICING);
      const micros = usageToMicros('test-model', {
        inputTokens: 200,
        outputTokens: 10,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 50,
      });
      // raw input = 200 - 100 - 50 = 50 → 50 * 100 = 5000
      // output = 10 * 200 = 2000
      // cache read = 100 * 10 = 1000
      // cache write = 50 * 150 = 7500
      // total = 15500
      expect(micros).toBe(15500);
    });

    it('clamps raw input at 0 when cache totals exceed input tokens (provider quirk)', () => {
      registerModelPricing('test-model', TEST_PRICING);
      const micros = usageToMicros('test-model', {
        inputTokens: 50,
        outputTokens: 0,
        cacheReadInputTokens: 60,
      });
      // raw input = max(0, 50 - 60) = 0 → no negative billing
      // cache read = 60 * 10 = 600
      expect(micros).toBe(600);
    });

    it('rounds the final cost to an integer (micros are whole numbers)', () => {
      registerModelPricing('frac-model', {
        inputMicrosPerToken: 0.15,
        outputMicrosPerToken: 0.6,
        cacheReadMicrosPerToken: 0.075,
        cacheWriteMicrosPerToken: 0.15,
      });
      const micros = usageToMicros('frac-model', {
        inputTokens: 1000,
        outputTokens: 500,
      });
      // 1000 * 0.15 + 500 * 0.6 = 150 + 300 = 450
      expect(micros).toBe(450);
      expect(Number.isInteger(micros)).toBe(true);
    });

    it('an unknown model uses the fallback rate (conservative — Opus by default)', () => {
      const fb = getFallbackPricing();
      const micros = usageToMicros('truly/unknown', {
        inputTokens: 10,
        outputTokens: 5,
      });
      // Should match fallback computation
      const expected = Math.round(
        10 * fb.inputMicrosPerToken + 5 * fb.outputMicrosPerToken,
      );
      expect(micros).toBe(expected);
    });

    it('a registered $0 model produces 0 cost', () => {
      registerModelPricing('local/free-model', {
        inputMicrosPerToken: 0,
        outputMicrosPerToken: 0,
        cacheReadMicrosPerToken: 0,
        cacheWriteMicrosPerToken: 0,
      });
      const micros = usageToMicros('local/free-model', {
        inputTokens: 100_000,
        outputTokens: 50_000,
      });
      expect(micros).toBe(0);
    });
  });

  describe('back-compat re-exports from runtime.js', () => {
    it('keeps usageToMicros and priceForModel importable from the old path', async () => {
      const runtime = await import('./runtime.js');
      expect(typeof runtime.usageToMicros).toBe('function');
      expect(typeof runtime.priceForModel).toBe('function');
      // Sanity: both paths point at the same implementation.
      expect(runtime.priceForModel('claude-opus-4-7')).toEqual(
        priceForModel('claude-opus-4-7'),
      );
    });
  });
});
