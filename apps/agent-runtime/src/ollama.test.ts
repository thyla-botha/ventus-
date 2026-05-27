import { describe, expect, it, vi } from 'vitest';
import { OllamaRuntime } from './ollama.js';
import type { RunInput, RunStepEvent } from './runtime.js';

// Note on test scope: the OpenAI-compatible chat loop, content
// normalization, cost-ceiling enforcement, kill-switch handling, and
// usage-required check all live in OpenAICompatibleRuntime — they're
// covered by openrouter.test.ts. Ollama tests focus on the Ollama-
// specific bits: constructor defaults, env vars, and confirming the
// `providerLabel` shows up in error messages instead of 'openrouter'.

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
  runtime: OllamaRuntime;
  createCalls: Array<Record<string, unknown>>;
} {
  const runtime = new OllamaRuntime();
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
  model: 'llama3.3:70b',
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

describe('OllamaRuntime', () => {
  describe('construction', () => {
    it('reports provider="ollama"', () => {
      const r = new OllamaRuntime();
      expect(r.provider).toBe('ollama');
    });

    it('does NOT require an API key (Ollama is unauthenticated by default)', () => {
      const prevKey = process.env.OLLAMA_API_KEY;
      delete process.env.OLLAMA_API_KEY;
      try {
        expect(() => new OllamaRuntime()).not.toThrow();
      } finally {
        if (prevKey !== undefined) process.env.OLLAMA_API_KEY = prevKey;
      }
    });

    it('reads OLLAMA_BASE_URL from env when no baseURL is passed', () => {
      const prev = process.env.OLLAMA_BASE_URL;
      process.env.OLLAMA_BASE_URL = 'http://gpu-box.lan:11434/v1';
      try {
        const r = new OllamaRuntime();
        const client = (r as unknown as { client: { baseURL: string } }).client;
        expect(client.baseURL).toBe('http://gpu-box.lan:11434/v1');
      } finally {
        if (prev === undefined) delete process.env.OLLAMA_BASE_URL;
        else process.env.OLLAMA_BASE_URL = prev;
      }
    });

    it('defaults baseURL to http://localhost:11434/v1 when no env or option is set', () => {
      const prev = process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_BASE_URL;
      try {
        const r = new OllamaRuntime();
        const client = (r as unknown as { client: { baseURL: string } }).client;
        expect(client.baseURL).toBe('http://localhost:11434/v1');
      } finally {
        if (prev !== undefined) process.env.OLLAMA_BASE_URL = prev;
      }
    });

    it('options.baseURL overrides the env var', () => {
      const prev = process.env.OLLAMA_BASE_URL;
      process.env.OLLAMA_BASE_URL = 'http://env-host:11434/v1';
      try {
        const r = new OllamaRuntime({ baseURL: 'http://opt-host:11434/v1' });
        const client = (r as unknown as { client: { baseURL: string } }).client;
        expect(client.baseURL).toBe('http://opt-host:11434/v1');
      } finally {
        if (prev === undefined) delete process.env.OLLAMA_BASE_URL;
        else process.env.OLLAMA_BASE_URL = prev;
      }
    });
  });

  describe('run', () => {
    it('completes on finish_reason=stop with the assistant text as finalText', async () => {
      const { runtime, createCalls } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'hi from llama' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 3 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const completed = events.find((e) => e.type === 'completed');
      expect((completed as { finalText: string }).finalText).toBe('hi from llama');
      // Verify the model string is passed through verbatim — Ollama uses
      // tag-style names like 'llama3.3:70b' that the API must not mutate.
      expect(createCalls[0]?.model).toBe('llama3.3:70b');
    });

    it('reports costMicros=0 for local inference (does NOT fall through to the global Opus fallback)', async () => {
      // Regression guard: before chunk 4 the OpenAI-compat base called
      // usageToMicros directly, which would mis-price an unknown
      // 'llama3.3:70b' tag at the conservative Opus fallback rate. Ollama
      // must override computeCostMicros to keep cost accounting honest.
      const { runtime } = makeRuntime([
        {
          choices: [
            {
              message: { role: 'assistant', content: 'free local run' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        },
      ]);
      const events = await collect(runtime.run(baseInput()));
      const assistant = events.find((e) => e.type === 'assistant_message') as {
        costMicros: number;
      };
      const completed = events.find((e) => e.type === 'completed') as {
        totalCostMicros: number;
      };
      expect(assistant.costMicros).toBe(0);
      expect(completed.totalCostMicros).toBe(0);
    });

    it('surfaces SDK errors with the ollama provider label (not openrouter)', async () => {
      // Confirms providerLabel wiring: error messages must say "ollama"
      // so operators reading logs can tell which adapter failed.
      const runtime = new OllamaRuntime();
      (runtime as unknown as { client: unknown }).client = {
        chat: {
          completions: {
            create: async () => {
              throw new Error('ECONNREFUSED');
            },
          },
        },
      };
      const events = await collect(runtime.run(baseInput()));
      const err = events.find((e) => e.type === 'error');
      expect((err as { error: string }).error).toMatch(/^ollama call failed/);
      expect((err as { error: string }).error).toMatch(/ECONNREFUSED/);
    });

    it('errors with ollama label when response.usage is missing', async () => {
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
      expect((err as { error: string }).error).toMatch(/^ollama response missing usage/);
    });

    it('translates tool_calls end-to-end (same shape as OpenRouter)', async () => {
      const toolExecutor = vi.fn(async () => ({ result: 'sent' }));
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
                      name: 'send_email',
                      arguments: JSON.stringify({ to: 'x@y.com' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 4 },
        },
        {
          choices: [
            {
              message: { role: 'assistant', content: 'done.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        },
      ]);
      const events = await collect(
        runtime.run(
          baseInput({
            tools: [{ name: 'send_email', description: 'd', inputSchema: {} }],
            toolExecutor,
          }),
        ),
      );
      expect(toolExecutor).toHaveBeenCalledWith(
        'send_email',
        { to: 'x@y.com' },
        expect.objectContaining({ tenantId: 't1', runId: 'r1', stepNo: 1 }),
      );
      expect(events.at(-1)?.type).toBe('completed');
      // Verify the assistant tool_calls anchor + role='tool' result message
      // get appended to the next request, same as OpenRouter.
      const secondMessages = createCalls[1]!.messages as Array<{
        role: string;
        tool_call_id?: string;
      }>;
      const toolMessage = secondMessages.find((m) => m.role === 'tool');
      expect(toolMessage?.tool_call_id).toBe('tc-1');
    });

    it('does NOT send any auth-identifying headers (Ollama is unauthenticated)', () => {
      // Sanity check that we didn't accidentally inherit OpenRouter's
      // HTTP-Referer / X-Title wiring. Ollama doesn't surface dashboard
      // attribution and doesn't accept those headers.
      const r = new OllamaRuntime();
      const client = (r as unknown as {
        client: { defaultHeaders?: Record<string, string> };
      }).client;
      const headers = client.defaultHeaders ?? {};
      expect(headers['HTTP-Referer']).toBeUndefined();
      expect(headers['X-Title']).toBeUndefined();
    });
  });
});
