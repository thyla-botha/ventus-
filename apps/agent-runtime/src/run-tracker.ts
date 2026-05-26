import type { RunCompletion } from '@ventus/store';
import type { RunStepEvent } from './runtime.js';
import { CREATE_PROPOSAL_TOOL } from './proposal-tool.js';

// Accumulates run-level accounting from the event stream so the caller (CLI,
// future API runner, future worker) can close the Run row with the right
// shape. Kept dumb on purpose: no I/O, no awaits, no side effects. The
// orchestration layer owns the RunStore call.
export class RunTracker {
  private totalCostMicros = 0;
  private proposalCount = 0;
  // tool_call ids whose name=create_proposal but whose tool_result hasn't
  // been seen yet. We only count a proposal once the matching tool_result
  // arrives with isError=false — a thrown tool execution (validation/store
  // failure) MUST NOT inflate the proposal count.
  private pendingProposalCallIds = new Set<string>();
  private terminal: RunCompletion | null = null;

  observe(event: RunStepEvent): void {
    switch (event.type) {
      case 'assistant_message':
        this.totalCostMicros += event.costMicros;
        return;
      case 'tool_call':
        if (event.name === CREATE_PROPOSAL_TOOL.name) {
          this.pendingProposalCallIds.add(event.id);
        }
        return;
      case 'tool_result':
        if (this.pendingProposalCallIds.delete(event.id) && !event.isError) {
          this.proposalCount += 1;
        }
        return;
      // Terminal events: first one wins. A well-behaved runtime emits exactly
      // one of completed/halted/error, but if the contract slips, prefer the
      // first authoritative close over later noise.
      case 'completed':
        if (this.terminal) return;
        this.terminal = {
          status: 'completed',
          totalCostMicros: event.totalCostMicros,
          proposalCount: this.proposalCount,
          finalText: event.finalText,
        };
        return;
      case 'halted':
        if (this.terminal) return;
        this.terminal = {
          status: 'halted',
          totalCostMicros: event.totalCostMicros,
          proposalCount: this.proposalCount,
          haltReason: event.reason,
        };
        return;
      case 'error':
        if (this.terminal) return;
        this.terminal = {
          status: 'failed',
          totalCostMicros: this.totalCostMicros,
          proposalCount: this.proposalCount,
          errorText: event.error,
        };
        return;
      default:
        return;
    }
  }

  // Returns a closing completion. If a terminal event was observed, returns it
  // verbatim. Otherwise synthesises a 'failed' close so a Run row is never
  // left in 'running' when the stream ends without a terminal event.
  finalize(opts?: { lastEvent?: string }): RunCompletion {
    if (this.terminal) return this.terminal;
    return {
      status: 'failed',
      totalCostMicros: this.totalCostMicros,
      proposalCount: this.proposalCount,
      errorText: `run ended without terminal event (last=${opts?.lastEvent ?? 'none'})`,
    };
  }

  // True iff a completed/halted/error event has been observed. Useful for
  // callers that want to distinguish "natural close" from "synthesised close".
  hasTerminal(): boolean {
    return this.terminal !== null;
  }
}
