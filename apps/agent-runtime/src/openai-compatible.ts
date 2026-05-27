import OpenAI from 'openai';
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.mjs';
import type {
  AgentRuntime,
  RunInput,
  RunStepEvent,
  TokenUsage,
} from './runtime.js';
import { usageToMicros } from './runtime.js';

// Shared base for OpenAI-compatible providers (OpenRouter, Ollama, vLLM,
// LM Studio, etc.). Subclasses supply the OpenAI client (pointed at the
// right baseURL) and a provider label used in error messages. The chat
// loop, content normalization, and security invariants (required usage,
// JSON-string tool arg parsing) live here so every OpenAI-compat adapter
// shares one well-tested implementation.
//
// Why this lives in its own file: keeps the per-provider adapters
// thin (just constructor wiring) and makes adding a 4th/5th adapter a
// 20-line job instead of 150.

export abstract class OpenAICompatibleRuntime implements AgentRuntime {
  abstract readonly provider: string;
  // Used in error messages. Usually matches `provider`, but subclasses
  // can override for clearer operator-facing diagnostics.
  protected abstract readonly providerLabel: string;
  protected client: OpenAI;

  constructor(client: OpenAI) {
    this.client = client;
  }

  async *run(input: RunInput): AsyncIterable<RunStepEvent> {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ];

    const tools: ChatCompletionTool[] = input.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    let totalCostMicros = 0;
    let stepNo = 0;
    let finalText = '';

    while (stepNo < input.maxSteps) {
      stepNo++;
      yield { type: 'step_started', stepNo };

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
          yield {
            type: 'error',
            error: `kill switch check failed: ${stringifyError(err)}`,
          };
          return;
        }
      }

      if (
        input.costCeilingMicros !== undefined &&
        totalCostMicros >= input.costCeilingMicros
      ) {
        yield {
          type: 'halted',
          reason: `cost_ceiling_reached (${totalCostMicros}/${input.costCeilingMicros} micros)`,
          totalCostMicros,
        };
        return;
      }

      let response;
      try {
        response = await this.client.chat.completions.create({
          model: input.model,
          max_tokens: input.maxTokens,
          messages,
          tools: tools.length > 0 ? tools : undefined,
        });
      } catch (err) {
        yield {
          type: 'error',
          error: `${this.providerLabel} call failed: ${stringifyError(err)}`,
        };
        return;
      }

      const choice = response.choices[0];
      if (!choice) {
        yield {
          type: 'error',
          error: `${this.providerLabel} response missing choices[0]`,
        };
        return;
      }

      // Refuse to silently zero out cost when the upstream omits usage:
      // costCeilingMicros is a security control (caps how much one run can
      // spend), and `usage` is optional in the OpenAI-compatible response
      // shape. A provider that returns no usage would let the loop run
      // unbounded with costMicros=0. Halt instead so the operator notices.
      const usageRaw = response.usage;
      if (
        !usageRaw ||
        typeof usageRaw.prompt_tokens !== 'number' ||
        typeof usageRaw.completion_tokens !== 'number'
      ) {
        yield {
          type: 'error',
          error: `${this.providerLabel} response missing usage — cannot enforce cost ceiling`,
        };
        return;
      }
      const usage: TokenUsage = {
        inputTokens: usageRaw.prompt_tokens,
        outputTokens: usageRaw.completion_tokens,
      };
      const costMicros = usageToMicros(input.model, usage);
      totalCostMicros += costMicros;

      // Normalize the assistant message into the same content-block shape
      // AnthropicRuntime emits so downstream consumers don't have to
      // branch on provider. AnthropicRuntime yields `ContentBlock[]` with
      // `text` and `tool_use` block kinds; we synthesize the same here.
      const assistantMessage = choice.message;
      const normalizedContent = normalizeAssistantContent(assistantMessage);
      yield {
        type: 'assistant_message',
        content: normalizedContent,
        stopReason: choice.finish_reason,
        costMicros,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
      };

      if (choice.finish_reason === 'stop') {
        finalText = assistantMessage.content ?? '';
        yield {
          type: 'completed',
          totalCostMicros,
          finalText,
          reason: choice.finish_reason,
        };
        return;
      }

      if (choice.finish_reason === 'length') {
        yield { type: 'error', error: 'response truncated at max_tokens' };
        return;
      }

      if (choice.finish_reason === 'content_filter') {
        yield { type: 'error', error: 'response blocked by content filter' };
        return;
      }

      if (choice.finish_reason !== 'tool_calls') {
        yield {
          type: 'error',
          error: `unexpected finish_reason: ${choice.finish_reason}`,
        };
        return;
      }

      const toolCalls = assistantMessage.tool_calls ?? [];
      if (toolCalls.length === 0) {
        yield {
          type: 'error',
          error: 'finish_reason=tool_calls but message.tool_calls is empty',
        };
        return;
      }

      // Append the assistant message verbatim so the next turn's history
      // includes the tool_calls anchors that the role='tool' messages
      // refer to.
      messages.push(assistantMessage);

      for (const tc of toolCalls) {
        const parsedInput = safeParseJson(tc.function.arguments);
        yield {
          type: 'tool_call',
          id: tc.id,
          name: tc.function.name,
          input: parsedInput,
        };

        let result: unknown;
        let isError = false;
        try {
          result = await input.toolExecutor(tc.function.name, parsedInput, {
            tenantId: input.tenantId,
            runId: input.runId,
            stepNo,
          });
        } catch (err) {
          isError = true;
          result = { error: stringifyError(err) };
        }

        yield { type: 'tool_result', id: tc.id, result, isError };

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      }
    }

    yield {
      type: 'error',
      error: `max_steps (${input.maxSteps}) exceeded without finish_reason=stop`,
    };
    void finalText;
  }
}

// Synthesize Anthropic-shaped content blocks from an OpenAI chat completion
// message. Downstream consumers (audit log, run-tracker, UI renderers)
// expect `text` + `tool_use` blocks — AnthropicRuntime emits this shape,
// so translating here keeps callers provider-agnostic.
interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
type NormalizedContentBlock = TextBlock | ToolUseBlock;

function normalizeAssistantContent(
  msg: ChatCompletionMessage,
): NormalizedContentBlock[] {
  const out: NormalizedContentBlock[] = [];
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    out.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    out.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: safeParseJson(tc.function.arguments),
    });
  }
  return out;
}

// Reject CR/LF/NUL in header values. Prevents header smuggling if a
// runtime constructor is wired to user/tenant-supplied config. Exported
// for subclasses that accept header-bound config (OpenRouter does).
export function assertSafeHeaderValue(field: string, value: string): void {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${field} contains control characters`);
  }
}

// Tool call arguments are a JSON string per the OpenAI spec. Models
// occasionally emit malformed JSON; surface the raw string in that case
// so the tool executor can either repair it or fail with a useful audit
// payload. We do NOT throw from here — throwing would kill the run
// before the audit layer sees the tool call.
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __parseError: true };
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
