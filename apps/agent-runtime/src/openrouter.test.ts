import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterRuntime } from './openrouter.js';
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
  usage?: { prompt_tokens: number; completion_tokens: number };
};

function makeRuntime(scriptedResponses: CompletionResult[]): {
  runtime: OpenRouterRuntime;
  createCalls: Array<Record<string, unknown>>;
} {
  const runtime = new OpenRouterRuntime({ apiKey: 'sk-test' });
  const createCalls: Array<Record<string, unknown>> = [];
  const queue = [...scriptedResponses];
  // Replace the SDK call surface with a deterministic stub. The runtime only
  // touches `client.chat.completions.create`, so a single function is enough.
  // Casts here are intentional — vitest's vi.mock would also do the same in
  // effect but produces less local test code.
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
  model: 'openai/gpt-4o-mini',
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

describe('OpenRouterRuntime', () => {
  describe('construction', () => {
    it('reports provider="openrouter"', () => {
      const r = new OpenRouterRuntime({ apiKey: 'sk-test' });
      expect(r.provider).toBe('openrouter');
    });

    it('throws when OPENROUTER_API_KEY is missing and no apiKey is passed', () => {
      const previous = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        expect(() => new OpenRouterRuntime()).toThrow(/OPENROUTER_API_KEY/);
      } finally {
        if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
      }
    });

    it('reads OPENROUTER_API_KEY from env when no apiKey is passed', () => {
      const previous = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'sk-env-test';
      try {
        expect(() => new OpenRouterRuntime()).not.toThrow();
      } finally {
        if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
        else process.env.OPENROUTER_API_KEY = previous;
      }
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

      // Tool was dispatched with parsed JSON, not the raw string.
      expect(toolExecutor).toHaveBeenCalledWith(
        'create_proposal',
        { x: 1 },
        expect.objectContaining({ tenantId: 't1', runId: 'r1', stepNo: 1 }),
      );

      // tool_call + tool_result events present in order.
      const types = events.map((e) => e.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_result');
      expect(types[types.length - 1]).toBe('completed');

      // Second create() call must include the role=tool message + the assistant
      // tool_calls anchor — otherwise OpenRouter rejects the call.
      const secondMessages = createCalls[1]!.messages as Array<{
        role: string;
        tool_call_id?: string;
      }>;
      const toolMessage = secondMessages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage!.tool_call_id).toBe('tc-1');
      const assistantWithToolCalls = secondMessages.find(
        (m) => m.role === 'assistant',
      ) as { tool_calls?: unknown[] };
      expect(assistantWithToolCalls.tool_calls).toBeDefined();
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

    it('errors on unexpected finish_reason values', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: null },
              finish_reason: 'function_call',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/unexpected finish_reason/);
    });

    it('errors when finish_reason=tool_calls but tool_calls is empty', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: null, tool_calls: [] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/tool_calls is empty/);
    });

    it('captures malformed JSON arguments without killing the run', async () => {
      // Some models occasionally emit malformed JSON; the audit log should
      // still capture the attempted tool call. We yield the tool_call with
      // a sentinel payload and pass it to the executor — which can then
      // either repair or fail loud.
      const toolExecutor = vi.fn(async () => 'recovered');
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc-bad',
                    type: 'function',
                    function: { name: 'noop', arguments: '{not-json}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 3 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'recovered.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'noop', description: 'd', inputSchema: {} }],
            toolExecutor,
          }),
        ),
      );
      const toolCall = events.find((e) => e.type === 'tool_call') as {
        input: { __parseError?: boolean; __raw?: string };
      };
      expect(toolCall.input.__parseError).toBe(true);
      expect(toolCall.input.__raw).toBe('{not-json}');
      expect(events[events.length - 1]?.type).toBe('completed');
    });

    it('catches tool executor throws and reports tool_result with isError=true', async () => {
      const toolExecutor = vi.fn(async () => {
        throw new Error('SMTP down');
      });
      const { runtime } = makeRuntime([
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
                    function: { name: 'send', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 2 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'handled.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'send', description: 'd', inputSchema: {} }],
            toolExecutor,
          }),
        ),
      );
      const result = events.find((e) => e.type === 'tool_result') as {
        isError: boolean;
        result: { error?: string };
      };
      expect(result.isError).toBe(true);
      expect(result.result.error).toBe('SMTP down');
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

    it('halts when cost ceiling is reached pre-step', async () => {
      // Force a non-zero cumulative cost on entry to step 2 by having step 1
      // return a tool_calls turn. The ceiling check happens BEFORE the API
      // call on each step, so step 2 should never invoke the API.
      const { runtime, createCalls } = makeRuntime([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 't',
                    type: 'function',
                    function: { name: 'noop', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'noop', description: 'd', inputSchema: {} }],
            toolExecutor: async () => 'ok',
            costCeilingMicros: 1, // immediately over after step 1
          }),
        ),
      );
      expect(createCalls).toHaveLength(1);
      const halted = events.find((e) => e.type === 'halted');
      expect((halted as { reason: string }).reason).toMatch(/cost_ceiling_reached/);
    });

    it('surfaces SDK errors via the API call as type=error and stops', async () => {
      const runtime = new OpenRouterRuntime({ apiKey: 'sk-test' });
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
      expect((err as { error: string }).error).toMatch(/openrouter call failed/);
      expect((err as { error: string }).error).toMatch(/upstream 502/);
    });

    it('exceeds max_steps without completing → error', async () => {
      const { runtime } = makeRuntime(
        Array.from({ length: 3 }, () => ({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'loop',
                    type: 'function',
                    function: { name: 'noop', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })),
      );
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'noop', description: 'd', inputSchema: {} }],
            toolExecutor: async () => 'ok',
            maxSteps: 2,
          }),
        ),
      );
      const err = events[events.length - 1];
      expect(err?.type).toBe('error');
      expect((err as { error: string }).error).toMatch(/max_steps/);
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
      await collect(
        runtime.run(baseInput({ model: 'meta-llama/llama-3.3-70b', maxTokens: 4096 })),
      );
      expect(createCalls[0]).toMatchObject({
        model: 'meta-llama/llama-3.3-70b',
        max_tokens: 4096,
      });
    });

    it('omits tools from the SDK call when no tools are declared', async () => {
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
      await collect(runtime.run(baseInput()));
      expect(createCalls[0]?.tools).toBeUndefined();
    });

    it('puts the system prompt as the first message (role=system) and user message second', async () => {
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
        runtime.run(
          baseInput({ systemPrompt: 'be helpful', userMessage: 'do thing' }),
        ),
      );
      const msgs = createCalls[0]!.messages as Array<{ role: string; content: string }>;
      expect(msgs[0]?.role).toBe('system');
      expect(msgs[0]?.content).toBe('be helpful');
      expect(msgs[1]?.role).toBe('user');
      expect(msgs[1]?.content).toBe('do thing');
    });

    it('errors out when response.usage is missing (cost ceiling cannot be enforced)', async () => {
      // Codex round-7 HIGH: a provider returning no usage would let the run
      // burn through tokens with costMicros=0, defeating the security cap.
      // The adapter must refuse to continue rather than silently zero out.
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

    it('errors out when response.usage is present but token counts are not numbers', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          // @ts-expect-error — deliberately malformed for the test
          usage: { prompt_tokens: '10', completion_tokens: 5 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/missing usage/);
    });

    it('normalizes assistant_message.content into Anthropic-shaped blocks (text + tool_use)', async () => {
      // Codex round-7 MED: downstream consumers (audit log, run-tracker, UI)
      // assume `content` is `ContentBlock[]` with `text`/`tool_use` block
      // kinds. The OpenAI message shape is different, so the adapter must
      // translate before yielding.
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'thinking...',
                tool_calls: [
                  {
                    id: 'tc-99',
                    type: 'function',
                    function: { name: 'noop', arguments: JSON.stringify({ a: 1 }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'done.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 2 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'noop', description: 'd', inputSchema: {} }],
            toolExecutor: async () => 'ok',
          }),
        ),
      );
      const assistantEvent = events.find((e) => e.type === 'assistant_message') as {
        content: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      };
      expect(Array.isArray(assistantEvent.content)).toBe(true);
      expect(assistantEvent.content[0]).toEqual({ type: 'text', text: 'thinking...' });
      expect(assistantEvent.content[1]).toMatchObject({
        type: 'tool_use',
        id: 'tc-99',
        name: 'noop',
        input: { a: 1 },
      });
    });

    it('omits empty/null text content when normalizing (only tool_use blocks)', async () => {
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc-only',
                    type: 'function',
                    function: { name: 'noop', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'noop', description: 'd', inputSchema: {} }],
            toolExecutor: async () => 'ok',
          }),
        ),
      );
      const assistantEvent = events.find((e) => e.type === 'assistant_message') as {
        content: Array<{ type: string }>;
      };
      expect(assistantEvent.content).toHaveLength(1);
      expect(assistantEvent.content[0]?.type).toBe('tool_use');
    });
  });

  describe('header injection guards (codex round-7 LOW)', () => {
    it('rejects appUrl containing CR/LF/NUL', () => {
      expect(
        () => new OpenRouterRuntime({ apiKey: 'sk-test', appUrl: 'https://x.test\r\nEvil: yes' }),
      ).toThrow(/control characters|valid URL/);
    });

    it('rejects appName containing CR/LF/NUL', () => {
      expect(
        () => new OpenRouterRuntime({ apiKey: 'sk-test', appName: 'evil\r\nX-Title: pwn' }),
      ).toThrow(/control characters/);
    });

    it('rejects appUrl that is not a parseable URL', () => {
      expect(
        () => new OpenRouterRuntime({ apiKey: 'sk-test', appUrl: 'not a url' }),
      ).toThrow(/valid URL/);
    });

    it('accepts a valid appUrl + appName combination', () => {
      expect(
        () =>
          new OpenRouterRuntime({
            apiKey: 'sk-test',
            appUrl: 'https://ventus.example',
            appName: 'Ventus',
          }),
      ).not.toThrow();
    });
  });
});
