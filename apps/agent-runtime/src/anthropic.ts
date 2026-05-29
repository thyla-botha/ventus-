import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.mjs';
import type { AgentRuntime, RunInput, RunStepEvent } from './runtime.js';
import { usageToMicros, type TokenUsage } from './pricing.js';

// Anthropic-backed runtime. Implements the AgentRuntime interface so callers
// stay vendor-agnostic. The loop:
//
//   1. Pre-step: check kill switch, check cost ceiling. Halt if either trips.
//   2. messages.create with current message history + tool definitions.
//   3. Yield assistant_message event with cost accounting.
//   4. If stop_reason is 'tool_use', dispatch each tool call via toolExecutor,
//      yield tool_call + tool_result events, append results to message history.
//   5. If stop_reason is 'end_turn', yield completed event with final text.
//   6. If max_steps reached without end_turn, yield error.

// SDK v0.30.x doesn't expose cache token fields on the typed Usage interface,
// though the API returns them. Read defensively via a widened type.
interface UsageWithCache {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class AnthropicRuntime implements AgentRuntime {
  readonly provider = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? '') {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey });
  }

  async *run(input: RunInput): AsyncIterable<RunStepEvent> {
    const messages: MessageParam[] = [
      { role: 'user', content: input.userMessage },
    ];

    let totalCostMicros = 0;
    let stepNo = 0;
    let finalText = '';

    while (stepNo < input.maxSteps) {
      stepNo++;
      yield { type: 'step_started', stepNo };

      // Kill switch check.
      if (input.killSwitchCheck) {
        try {
          const halted = await input.killSwitchCheck();
          if (halted) {
            yield {
              type: 'halted',
              reason: 'kill_switch_tripped',
              totalCostMicros,
            };
            return;
          }
        } catch (err) {
          yield { type: 'error', error: `kill switch check failed: ${stringifyError(err)}` };
          return;
        }
      }

      // Cost ceiling check (pre-step, since we don't know this call's cost yet).
      if (input.costCeilingMicros !== undefined && totalCostMicros >= input.costCeilingMicros) {
        yield {
          type: 'halted',
          reason: `cost_ceiling_reached (${totalCostMicros}/${input.costCeilingMicros} micros)`,
          totalCostMicros,
        };
        return;
      }

      let response;
      try {
        response = await this.client.messages.create({
          model: input.model,
          max_tokens: input.maxTokens,
          system: input.systemPrompt,
          tools: input.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
          })),
          messages,
        });
      } catch (err) {
        yield { type: 'error', error: `anthropic call failed: ${stringifyError(err)}` };
        return;
      }

      // Anthropic reports the three token classes as mutually exclusive
      // counts: `input_tokens` is the NON-cached portion only, while
      // `cache_read_input_tokens` and `cache_creation_input_tokens` are
      // SEPARATE totals. The platform-wide `usageToMicros` was written
      // around the OpenAI convention (`prompt_tokens` is the GRAND TOTAL
      // including cache portions, with cache_read/cache_creation as
      // subsets). Roll the Anthropic counts up so the cost calculator
      // gets the input it was designed for: a true grand total to
      // subtract from, with the cache subsets billed at their own rates.
      // Without this rollup, cached prompts under-bill the regular input
      // (it gets clamped to 0 when cache totals exceed input_tokens).
      const usageRaw = response.usage as UsageWithCache;
      const cacheReadInputTokens = usageRaw.cache_read_input_tokens ?? 0;
      const cacheCreationInputTokens = usageRaw.cache_creation_input_tokens ?? 0;
      const inputTokensForBilling =
        usageRaw.input_tokens + cacheReadInputTokens + cacheCreationInputTokens;
      const usage: TokenUsage = {
        inputTokens: inputTokensForBilling,
        outputTokens: usageRaw.output_tokens,
        ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
        ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
      };
      const costMicros = usageToMicros(input.model, usage);
      totalCostMicros += costMicros;

      yield {
        type: 'assistant_message',
        content: response.content,
        stopReason: response.stop_reason,
        costMicros,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
      };

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
        finalText = extractText(response.content);
        yield {
          type: 'completed',
          totalCostMicros,
          finalText,
          reason: response.stop_reason,
        };
        return;
      }

      if (response.stop_reason === 'max_tokens') {
        yield { type: 'error', error: 'response truncated at max_tokens' };
        return;
      }

      if (response.stop_reason !== 'tool_use') {
        yield { type: 'error', error: `unexpected stop_reason: ${response.stop_reason}` };
        return;
      }

      // Dispatch each tool_use block.
      const toolUses = response.content.filter(isToolUse);
      const resultBlocks: ToolResultBlockParam[] = [];

      for (const tu of toolUses) {
        yield { type: 'tool_call', id: tu.id, name: tu.name, input: tu.input };

        let result: unknown;
        let isError = false;
        try {
          result = await input.toolExecutor(tu.name, tu.input, {
            tenantId: input.tenantId,
            runId: input.runId,
            stepNo,
          });
        } catch (err) {
          isError = true;
          result = { error: stringifyError(err) };
        }

        yield { type: 'tool_result', id: tu.id, result, isError };

        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: isError,
          content:
            typeof result === 'string' ? result : JSON.stringify(result),
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: resultBlocks });
    }

    yield {
      type: 'error',
      error: `max_steps (${input.maxSteps}) exceeded without end_turn`,
    };
  }
}

function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('\n');
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
