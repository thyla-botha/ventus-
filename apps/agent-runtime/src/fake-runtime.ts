import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  RunInput,
  RunStepEvent,
} from './runtime.js';

// Scripted runtime for tests. Replaces AnthropicRuntime so the agent loop can
// be exercised end-to-end (tool dispatch, audit writes, proposal creation)
// without spending tokens or relying on network determinism.
//
// Each "turn" in the script represents one assistant_message + its
// tool_use blocks. The harness executes the tool_use blocks against the
// caller-supplied toolExecutor, mirroring AnthropicRuntime's loop. Use:
//
//   const runtime = new FakeAgentRuntime({
//     turns: [
//       { tools: [{ name: 'create_proposal', input: { ... } }] },
//       { text: 'Done. Proposal staged.' },
//     ],
//   });
//
// Turns are consumed in order. Each turn is either:
//   - { tools: [{name, input}, ...] }     → emits a tool_use turn
//   - { text: '...' }                     → emits an end_turn with text
//   - { error: '...' }                    → emits an error event and stops
//   - { halt: 'reason' }                  → emits a halted event and stops
//
// LIMITATIONS — what this fake does NOT model (vs AnthropicRuntime):
//   - Message history is not tracked. The script is preset; turns cannot
//     branch on prior tool_result content. Use the real runtime for tests
//     that depend on the model adapting to tool output.
//   - tool_result content is not re-encoded; the harness emits the raw
//     return value in the tool_result event. Anthropic encodes results as
//     either string or JSON.stringify(result) — that conversion is not
//     exercised here.
//   - stop_reason variants (max_tokens, stop_sequence) are not exposed via
//     the script API; use { error } or { text } to terminate.
// These trade-offs keep the fake simple and deterministic; the seams it does
// model (kill switch, cost ceiling, max_steps, tool dispatch order) match
// AnthropicRuntime exactly.

export type FakeTurn =
  | { tools: Array<{ name: string; input: unknown; id?: string }>; tokensIn?: number; tokensOut?: number; costMicros?: number }
  | { text: string; tokensIn?: number; tokensOut?: number; costMicros?: number }
  | { error: string }
  | { halt: string };

export interface FakeRuntimeOptions {
  turns: FakeTurn[];
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly provider = 'fake';
  constructor(private readonly opts: FakeRuntimeOptions) {}

  async *run(input: RunInput): AsyncIterable<RunStepEvent> {
    const script = this.opts.turns.slice();
    let stepNo = 0;
    let totalCostMicros = 0;

    while (stepNo < input.maxSteps) {
      stepNo++;
      yield { type: 'step_started', stepNo };

      if (input.killSwitchCheck) {
        try {
          const halted = await input.killSwitchCheck();
          if (halted) {
            yield { type: 'halted', reason: 'kill_switch_tripped', totalCostMicros };
            return;
          }
        } catch (err) {
          yield {
            type: 'error',
            error: `kill switch check failed: ${err instanceof Error ? err.message : String(err)}`,
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

      const turn = script.shift();
      if (!turn) {
        yield { type: 'error', error: 'fake runtime ran out of scripted turns' };
        return;
      }

      if ('error' in turn) {
        yield { type: 'error', error: turn.error };
        return;
      }
      if ('halt' in turn) {
        yield { type: 'halted', reason: turn.halt, totalCostMicros };
        return;
      }

      if ('text' in turn) {
        const cost = turn.costMicros ?? 0;
        totalCostMicros += cost;
        yield {
          type: 'assistant_message',
          content: [{ type: 'text', text: turn.text }],
          stopReason: 'end_turn',
          costMicros: cost,
          tokensIn: turn.tokensIn ?? 0,
          tokensOut: turn.tokensOut ?? 0,
        };
        yield {
          type: 'completed',
          totalCostMicros,
          finalText: turn.text,
          reason: 'end_turn',
        };
        return;
      }

      // tool_use turn
      const cost = turn.costMicros ?? 0;
      totalCostMicros += cost;
      const toolUseBlocks = turn.tools.map((t) => ({
        type: 'tool_use' as const,
        id: t.id ?? `tu_${randomUUID()}`,
        name: t.name,
        input: t.input,
      }));
      yield {
        type: 'assistant_message',
        content: toolUseBlocks,
        stopReason: 'tool_use',
        costMicros: cost,
        tokensIn: turn.tokensIn ?? 0,
        tokensOut: turn.tokensOut ?? 0,
      };

      for (const tu of toolUseBlocks) {
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
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        yield { type: 'tool_result', id: tu.id, result, isError };
      }
    }

    yield {
      type: 'error',
      error: `max_steps (${input.maxSteps}) exceeded without end_turn`,
    };
  }
}
