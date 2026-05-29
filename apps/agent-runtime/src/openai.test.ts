import { describe, expect, it, vi } from 'vitest';
import { OpenAIRuntime } from './openai.js';
import type { RunInput, RunStepEvent } from './runtime.js';

type CompletionResult = {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

function makeRuntime(scriptedResponses: CompletionResult[]): {
  runtime: OpenAIRuntime;
  createCalls: Array<Record<string, unknown>>;
} {
  const runtime = new OpenAIRuntime({ apiKey: 'sk-test' });
  const createCalls: Array<Record<string, unknown>> = [];
  const queue = [...scriptedResponses];
  (runtime as unknown as {
    client: { chat: { completions: { create: typeof stub } } };
  }).client = {
    chat: {
      completions: {
        create: stub,
      },
    },
  };
  async function stub(req: Record<string, unknown>): Promise<CompletionResult> {
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
  model: 'gpt-4o-mini',
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

describe('OpenAIRuntime', () => {
  describe('construction', () => {
    it('reports provider="openai"', () => {
      const r = new OpenAIRuntime({ apiKey: 'sk-test' });
      expect(r.provider).toBe('openai');
    });

    it('throws when OPENAI_API_KEY is missing and no apiKey is passed', () => {
      const previous = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        expect(() => new OpenAIRuntime()).toThrow(/OPENAI_API_KEY/);
      } finally {
        if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
      }
    });

    it('reads OPENAI_API_KEY from env when no apiKey is passed', () => {
      const previous = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-env-test';
      try {
        expect(() => new OpenAIRuntime()).not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous;
      }
    });

    it('accepts optional organization + project IDs', () => {
      expect(
        () =>
          new OpenAIRuntime({
            apiKey: 'sk-test',
            organization: 'org-ventus',
            project: 'proj-real-estate',
          }),
      ).not.toThrow();
    });
  });

  describe('run', () => {
    it('completes on finish_reason=stop with the assistant text as finalText', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'hello world' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const completed = events.find((e) => e.type === 'completed');
      expect(completed).toBeDefined();
      expect((completed as { finalText: string }).finalText).toBe('hello world');
      expect((completed as { reason: string }).reason).toBe('stop');
    });

    it('translates OpenAI tool_calls → AgentRuntime tool_call events and back via role=tool messages', async () => {
      const toolExecutor = vi.fn(async () => ({ result: 'ok' }));
      const { runtime, createCalls } = makeRuntime([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc-1',
                    type: 'function',
                    function: {
                      name: 'create_proposal',
                      arguments: JSON.stringify({ x: 1 }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'done.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        },
      ]);

      const events = await collect(
        runtime.run(
          baseInput({
            tools: [
              {
                name: 'create_proposal',
                description: 'd',
                inputSchema: { type: 'object' },
              },
            ],
            toolExecutor,
          }),
        ),
      );

      expect(toolExecutor).toHaveBeenCalledWith(
        'create_proposal',
        { x: 1 },
        expect.objectContaining({ tenantId: 't1', runId: 'r1', stepNo: 1 }),
      );

      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types[types.length - 1]).toBe('completed');

      const secondMessages = createCalls[1]!.messages as Array<{
        role: string;
        tool_call_id?: string;
      }>;
      const toolMessage = secondMessages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.tool_call_id).toBe('tc-1');
    });

    it('maps finish_reason=length to a truncation error', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'partial...' },
              finish_reason: 'length',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect((err as { error: string }).error).toMatch(/max_tokens/);
    });

    it('maps finish_reason=content_filter to a content-filter error', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: null },
              finish_reason: 'content_filter',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/content filter/);
    });

    it('passes the configured model and max_tokens to the SDK call', async () => {
      const { runtime, createCalls } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
      ]);
      await collect(runtime.run(baseInput({ model: 'gpt-4o', maxTokens: 4096 })));
      expect(createCalls[0]).toMatchObject({
        model: 'gpt-4o',
        max_tokens: 4096,
      });
    });

    it('puts the system prompt first and user message second', async () => {
      const { runtime, createCalls } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
      ]);
      await collect(
        runtime.run(baseInput({ systemPrompt: 'be helpful', userMessage: 'do thing' })),
      );
      const msgs = createCalls[0]!.messages as Array<{ role: string; content: string }>;
      expect(msgs[0]?.role).toBe('system');
      expect(msgs[0]?.content).toBe('be helpful');
      expect(msgs[1]?.role).toBe('user');
      expect(msgs[1]?.content).toBe('do thing');
    });

    it('errors out when response.usage is missing (cost ceiling cannot be enforced)', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect(err).toBeDefined();
      expect((err as { error: string }).error).toMatch(/missing usage/);
    });

    it('surfaces SDK errors via the API call as type=error and stops', async () => {
      const runtime = new OpenAIRuntime({ apiKey: 'sk-test' });
      (runtime as unknown as { client: unknown }).client = {
        chat: {
          completions: {
            create: async () => {
              throw new Error('upstream 502');
            },
          },
        },
      };
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/openai call failed/);
      expect((err as { error: string }).error).toMatch(/upstream 502/);
    });

    it('halts when kill switch trips before the API call', async () => {
      const { runtime, createCalls } = makeRuntime([]);
      const events = await collect(
        runtime.run(baseInput({ killSwitchCheck: async () => true })),
      );
      expect(createCalls).toHaveLength(0);
      const halted = events.find((e) => e.type === 'halted');
      expect((halted as { reason: string }).reason).toBe('kill_switch_tripped');
    });
  });

  describe('header injection guards', () => {
    it('rejects organization containing CR/LF/NUL', () => {
      expect(
        () =>
          new OpenAIRuntime({
            apiKey: 'sk-test',
            organization: 'org\r\nOpenAI-Project: pwn',
          }),
      ).toThrow(/control or line-separator characters/);
    });

    it('rejects project containing CR/LF/NUL', () => {
      expect(
        () =>
          new OpenAIRuntime({
            apiKey: 'sk-test',
            project: 'proj\r\nX-Inject: yes',
          }),
      ).toThrow(/control or line-separator characters/);
    });
  });

  describe('prompt-cache cost accounting (PR 3/6)', () => {
    // OpenAI / OpenRouter cached prompts: when a tenant reuses a long
    // system prompt across runs, the API reports the cached portion via
    // `usage.prompt_tokens_details.cached_tokens`. Those tokens were a
    // CACHE READ, billed at ~10% of input rate (gpt-4o-mini: 0.075 vs
    // 0.15 micros/token). Treating them as regular input over-bills the
    // tenant and trips the cost ceiling earlier than reality.
    it('extracts cached_tokens from prompt_tokens_details and bills at cache-read rate', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'cached hello' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        },
      ]);
      const events = await collect(runtime.run(baseInput({ model: 'gpt-4o-mini' })));
      const completed = events.find((e) => e.type === 'completed') as {
        totalCostMicros: number;
      };
      // gpt-4o-mini pricing (from PR 1):
      //   input:        0.15 micros/token
      //   output:       0.6  micros/token
      //   cacheRead:    0.075 micros/token
      // usage: prompt_tokens=1000 total, cached_tokens=800 → raw input = 200
      // cost: 200*0.15 + 50*0.6 + 800*0.075 = 30 + 30 + 60 = 120 micros
      expect(completed.totalCostMicros).toBe(120);
    });

    it('falls back to standard input billing when prompt_tokens_details is absent', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'no cache' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 50 },
        },
      ]);
      const events = await collect(runtime.run(baseInput({ model: 'gpt-4o-mini' })));
      const completed = events.find((e) => e.type === 'completed') as {
        totalCostMicros: number;
      };
      // No cache → 1000*0.15 + 50*0.6 = 150 + 30 = 180 micros
      expect(completed.totalCostMicros).toBe(180);
    });

    it('ignores cached_tokens when it is zero (no cache hit)', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'cold prompt' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
      ]);
      const events = await collect(runtime.run(baseInput({ model: 'gpt-4o-mini' })));
      const completed = events.find((e) => e.type === 'completed') as {
        totalCostMicros: number;
      };
      // Same as no-details case: 1000*0.15 + 50*0.6 = 180
      expect(completed.totalCostMicros).toBe(180);
    });

    it('ignores cached_tokens when malformed (NaN / negative / Infinity)', async () => {
      for (const bad of [Number.NaN, -100, Number.POSITIVE_INFINITY, 1.5]) {
        const { runtime } = makeRuntime([
          {
            choices: [
              {
                message: { role: 'assistant', content: 'bad cache field' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              prompt_tokens_details: { cached_tokens: bad },
            },
          },
        ]);
        const events = await collect(
          runtime.run(baseInput({ model: 'gpt-4o-mini' })),
        );
        const completed = events.find((e) => e.type === 'completed') as {
          totalCostMicros: number;
        };
        // Malformed → ignore the field, bill as if no cache (180 micros).
        expect(completed.totalCostMicros).toBe(180);
      }
    });
  });
});
