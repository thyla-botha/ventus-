import { describe, expect, it } from 'vitest';
import { AnthropicRuntime } from './anthropic.js';
import type { RunInput, RunStepEvent } from './runtime.js';

// Minimal stub of the Anthropic messages.create response shape — only the
// fields the adapter touches. Cache-token fields use Anthropic's
// SEPARATE-counts semantics (input_tokens = non-cached portion only,
// cache_read_input_tokens and cache_creation_input_tokens are their own
// totals). The adapter rolls them up before handing off to usageToMicros.
type AnthropicResponse = {
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: 'end_turn' | 'stop_sequence' | 'max_tokens' | 'tool_use' | string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
};

function makeRuntime(scriptedResponses: AnthropicResponse[]): {
  runtime: AnthropicRuntime;
  createCalls: Array<Record<string, unknown>>;
} {
  const runtime = new AnthropicRuntime('sk-test');
  const createCalls: Array<Record<string, unknown>> = [];
  const queue = [...scriptedResponses];
  (runtime as unknown as {
    client: { messages: { create: typeof stub } };
  }).client = {
    messages: { create: stub },
  };
  async function stub(req: Record<string, unknown>): Promise<AnthropicResponse> {
    createCalls.push(req);
    const next = queue.shift();
    if (!next) throw new Error('test stub: no scripted response left');
    return next;
  }
  return { runtime, createCalls };
}

const baseInput = (over: Partial<RunInput> = {}): RunInput => ({
  tenantId: 't1',
  runId: 'r1',
  agentId: 'a1',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'sys',
  userMessage: 'hi',
  tools: [],
  toolExecutor: async () => 'no-tools',
  maxSteps: 5,
  maxTokens: 256,
  ...over,
});

async function collect(it: AsyncIterable<RunStepEvent>): Promise<RunStepEvent[]> {
  const events: RunStepEvent[] = [];
  for await (const e of it) events.push(e);
  return events;
}

describe('AnthropicRuntime prompt-cache cost accounting (PR 3/6)', () => {
  it('bills cache-read tokens at the cache-read rate, not the input rate', async () => {
    // Tenant runs claude-sonnet-4-6 with a cached system prompt.
    // Anthropic returns: input_tokens=200 (the un-cached USER message),
    // cache_read_input_tokens=2000 (the cached system prompt).
    // Without the adapter rollup, usageToMicros would clamp raw input to
    // 0 (200 - 2000 < 0) and we'd lose the 200-token user-input charge.
    const { runtime } = makeRuntime([
      {
        content: [{ type: 'text', text: 'cached response' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 2000,
        },
      },
    ]);
    const events = await collect(runtime.run(baseInput()));
    const completed = events.find((e) => e.type === 'completed') as {
      totalCostMicros: number;
    };
    // claude-sonnet-4-6 pricing (from pricing.ts):
    //   input:        3    micros/token
    //   output:       15   micros/token
    //   cacheRead:    0.3  micros/token
    //   cacheWrite:   3.75 micros/token
    // Rolled-up input total: 200 + 2000 = 2200. Subtract cacheRead+cacheWrite
    // inside usageToMicros: raw = 2200 - 2000 - 0 = 200 → 200*3 = 600.
    // Output: 100 * 15 = 1500. Cache read: 2000 * 0.3 = 600.
    // Total: 600 + 1500 + 600 = 2700 micros.
    expect(completed.totalCostMicros).toBe(2700);
  });

  it('bills cache-creation tokens at the cache-write rate', async () => {
    // First-time cache fill. Anthropic returns:
    // input_tokens=200 (user msg), cache_creation_input_tokens=2000 (system).
    const { runtime } = makeRuntime([
      {
        content: [{ type: 'text', text: 'cold cache fill' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_creation_input_tokens: 2000,
        },
      },
    ]);
    const events = await collect(runtime.run(baseInput()));
    const completed = events.find((e) => e.type === 'completed') as {
      totalCostMicros: number;
    };
    // Rolled-up total: 200 + 0 + 2000 = 2200. raw = 2200 - 0 - 2000 = 200.
    // 200*3 + 100*15 + 2000*3.75 = 600 + 1500 + 7500 = 9600 micros.
    expect(completed.totalCostMicros).toBe(9600);
  });

  it('falls back to standard input billing when cache fields are absent', async () => {
    const { runtime } = makeRuntime([
      {
        content: [{ type: 'text', text: 'no cache' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100 },
      },
    ]);
    const events = await collect(runtime.run(baseInput()));
    const completed = events.find((e) => e.type === 'completed') as {
      totalCostMicros: number;
    };
    // No cache → 1000*3 + 100*15 = 3000 + 1500 = 4500 micros.
    expect(completed.totalCostMicros).toBe(4500);
  });

  it('handles null cache fields (Anthropic returns null when caching not enabled)', async () => {
    const { runtime } = makeRuntime([
      {
        content: [{ type: 'text', text: 'null cache fields' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    ]);
    const events = await collect(runtime.run(baseInput()));
    const completed = events.find((e) => e.type === 'completed') as {
      totalCostMicros: number;
    };
    // Same as absent-field case.
    expect(completed.totalCostMicros).toBe(4500);
  });

  it('handles cache-read + cache-write in the same response', async () => {
    // Mixed scenario: tenant re-runs with the same system prompt plus a
    // fresh attachment, so part is a cache READ and part is fresh cache
    // WRITE. Both should be billed at their own rates and not collide.
    const { runtime } = makeRuntime([
      {
        content: [{ type: 'text', text: 'mixed cache' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1500,
          cache_creation_input_tokens: 500,
        },
      },
    ]);
    const events = await collect(runtime.run(baseInput()));
    const completed = events.find((e) => e.type === 'completed') as {
      totalCostMicros: number;
    };
    // Rolled-up: 100 + 1500 + 500 = 2100. raw = 2100 - 1500 - 500 = 100.
    // 100*3 + 50*15 + 1500*0.3 + 500*3.75 = 300 + 750 + 450 + 1875 = 3375.
    expect(completed.totalCostMicros).toBe(3375);
  });
});
