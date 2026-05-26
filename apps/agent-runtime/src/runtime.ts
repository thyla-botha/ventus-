// Vendor-agnostic agent runtime.
//
// Decouples agent definitions and the orchestration layer from any single LLM
// vendor's SDK shape. Concrete implementations (AnthropicRuntime, future
// BedrockRuntime, VertexRuntime) satisfy the same AgentRuntime interface so
// switching providers does not require rewriting Skills or callers.

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolContext {
  tenantId: string;
  runId: string;
  stepNo: number;
}

// Contract for tool implementations.
//
// Resolution semantics:
//   - returning normally → the side effect committed; the audit layer records
//     status='executed'. Implementations MUST NOT throw after a side effect
//     has been performed. Swallow post-commit failures (e.g. log + return a
//     best-effort summary) so the audit accurately reflects reality.
//   - throwing → the side effect did NOT commit. The audit layer records
//     status='failed'. If you cannot tell whether a side effect committed
//     (e.g. network call timed out after the request was sent), surface that
//     uncertainty in the return value rather than re-throwing.
export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: ToolContext,
) => Promise<unknown>;

export interface RunInput {
  tenantId: string;
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  tools: ToolDefinition[];
  toolExecutor: ToolExecutor;
  maxSteps: number;
  maxTokens: number;
  // Halt the run when cumulative cost reaches this ceiling. Units: micro-dollars.
  costCeilingMicros?: number;
  // Called before each step. Return true to halt (kill switch tripped, tenant
  // disabled, etc.). The runtime treats true as terminal.
  killSwitchCheck?: () => Promise<boolean>;
}

export type RunStepEvent =
  | { type: 'step_started'; stepNo: number }
  | {
      type: 'assistant_message';
      content: unknown;
      stopReason: string | null;
      costMicros: number;
      tokensIn: number;
      tokensOut: number;
    }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown; isError: boolean }
  | { type: 'completed'; totalCostMicros: number; finalText: string; reason: string }
  | { type: 'halted'; reason: string; totalCostMicros: number }
  | { type: 'error'; error: string };

export interface AgentRuntime {
  // Stable identifier of the underlying provider (e.g. 'anthropic', 'fake').
  // Folded into the Run's contextSnapshotHash so two runs that hit different
  // providers — even with the same model name — are recognisably distinct.
  readonly provider: string;
  run(input: RunInput): AsyncIterable<RunStepEvent>;
}

// ----------------------------------------------------------------------------
// Pricing. Approximate model pricing in micro-dollars per token.
// Cached input tokens are billed at ~10% of standard input rate per Anthropic
// caching docs at time of writing; verify before relying on these numbers.
// ----------------------------------------------------------------------------
interface ModelPricing {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
  cacheReadMicrosPerToken: number;
  cacheWriteMicrosPerToken: number;
}

const PRICING: Record<string, ModelPricing> = {
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
};

const FALLBACK_PRICING: ModelPricing = PRICING['claude-sonnet-4-6']!;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export function priceForModel(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK_PRICING;
}

export function usageToMicros(model: string, usage: TokenUsage): number {
  const p = priceForModel(model);
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const rawInput = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
  return Math.round(
    rawInput * p.inputMicrosPerToken
    + usage.outputTokens * p.outputMicrosPerToken
    + cacheRead * p.cacheReadMicrosPerToken
    + cacheWrite * p.cacheWriteMicrosPerToken,
  );
}
