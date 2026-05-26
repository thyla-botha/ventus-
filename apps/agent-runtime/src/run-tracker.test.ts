import { describe, expect, it } from 'vitest';
import { RunTracker } from './run-tracker.js';
import type { RunStepEvent } from './runtime.js';

function feed(t: RunTracker, events: RunStepEvent[]): void {
  for (const e of events) t.observe(e);
}

describe('RunTracker', () => {
  it('observes a completed run and returns the completed shape', () => {
    const t = new RunTracker();
    feed(t, [
      { type: 'step_started', stepNo: 1 },
      {
        type: 'assistant_message',
        content: [],
        stopReason: 'tool_use',
        costMicros: 100,
        tokensIn: 50,
        tokensOut: 25,
      },
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc1', result: { proposal_id: 'p1' }, isError: false },
      { type: 'step_started', stepNo: 2 },
      {
        type: 'assistant_message',
        content: [],
        stopReason: 'end_turn',
        costMicros: 50,
        tokensIn: 60,
        tokensOut: 10,
      },
      { type: 'completed', totalCostMicros: 150, finalText: 'all done.', reason: 'end_turn' },
    ]);

    expect(t.hasTerminal()).toBe(true);
    expect(t.finalize()).toEqual({
      status: 'completed',
      totalCostMicros: 150,
      proposalCount: 1,
      finalText: 'all done.',
    });
  });

  it('counts proposals only when create_proposal tool_result lands with isError=false', () => {
    const t = new RunTracker();
    feed(t, [
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc1', result: { proposal_id: 'p1' }, isError: false },
      { type: 'tool_call', id: 'tc2', name: 'search_docs', input: {} },
      { type: 'tool_result', id: 'tc2', result: [], isError: false },
      { type: 'tool_call', id: 'tc3', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc3', result: { proposal_id: 'p2' }, isError: false },
      { type: 'tool_call', id: 'tc4', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc4', result: { proposal_id: 'p3' }, isError: false },
      { type: 'completed', totalCostMicros: 0, finalText: '', reason: 'end_turn' },
    ]);
    const c = t.finalize();
    expect(c.proposalCount).toBe(3);
  });

  it('does NOT count create_proposal calls whose tool_result has isError=true', () => {
    const t = new RunTracker();
    feed(t, [
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      // store write failed / Zod validation rejected the payload
      { type: 'tool_result', id: 'tc1', result: 'validation error', isError: true },
      { type: 'tool_call', id: 'tc2', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc2', result: { proposal_id: 'p2' }, isError: false },
      { type: 'completed', totalCostMicros: 0, finalText: '', reason: 'end_turn' },
    ]);
    expect(t.finalize().proposalCount).toBe(1);
  });

  it('does NOT count a create_proposal call whose tool_result never arrived (stream cut)', () => {
    // tool_call without matching tool_result — e.g. runtime threw between
    // emitting tool_call and emitting tool_result. Optimistically counting
    // would inflate the cost view; we count zero.
    const t = new RunTracker();
    feed(t, [
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      // no tool_result for tc1
    ]);
    const c = t.finalize({ lastEvent: 'tool_call' });
    expect(c.proposalCount).toBe(0);
  });

  it('captures halted with haltReason + totalCostMicros from the event', () => {
    const t = new RunTracker();
    feed(t, [
      {
        type: 'assistant_message',
        content: [],
        stopReason: null,
        costMicros: 200,
        tokensIn: 100,
        tokensOut: 50,
      },
      { type: 'halted', reason: 'cost_ceiling_reached', totalCostMicros: 200 },
    ]);
    expect(t.finalize()).toEqual({
      status: 'halted',
      totalCostMicros: 200,
      proposalCount: 0,
      haltReason: 'cost_ceiling_reached',
    });
  });

  it('captures error using accumulated cost (error event has no total)', () => {
    const t = new RunTracker();
    feed(t, [
      {
        type: 'assistant_message',
        content: [],
        stopReason: null,
        costMicros: 75,
        tokensIn: 30,
        tokensOut: 15,
      },
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc1', result: { proposal_id: 'p1' }, isError: false },
      { type: 'error', error: 'anthropic call failed: rate limited' },
    ]);
    expect(t.finalize()).toEqual({
      status: 'failed',
      totalCostMicros: 75,
      proposalCount: 1,
      errorText: 'anthropic call failed: rate limited',
    });
  });

  it('synthesises failed close when stream ends without terminal event', () => {
    const t = new RunTracker();
    feed(t, [
      { type: 'step_started', stepNo: 1 },
      {
        type: 'assistant_message',
        content: [],
        stopReason: 'tool_use',
        costMicros: 40,
        tokensIn: 20,
        tokensOut: 10,
      },
      { type: 'tool_call', id: 'tc1', name: 'create_proposal', input: {} },
      { type: 'tool_result', id: 'tc1', result: { proposal_id: 'p1' }, isError: false },
    ]);

    expect(t.hasTerminal()).toBe(false);
    expect(t.finalize({ lastEvent: 'tool_result' })).toEqual({
      status: 'failed',
      totalCostMicros: 40,
      proposalCount: 1,
      errorText: 'run ended without terminal event (last=tool_result)',
    });
  });

  it('synthesised close defaults lastEvent to "none" when unspecified', () => {
    const t = new RunTracker();
    const c = t.finalize();
    expect(c.status).toBe('failed');
    expect(c.errorText).toBe('run ended without terminal event (last=none)');
  });

  it('first terminal event wins (subsequent terminal-shape events ignored)', () => {
    // Defense against a buggy runtime that emits both completed and error.
    // The first authoritative close should be preserved.
    const t = new RunTracker();
    feed(t, [
      { type: 'completed', totalCostMicros: 100, finalText: 'ok', reason: 'end_turn' },
      { type: 'error', error: 'late failure' },
    ]);
    expect(t.finalize().status).toBe('completed');
  });

  it('ignores unrelated events (step_started, tool_result)', () => {
    const t = new RunTracker();
    feed(t, [
      { type: 'step_started', stepNo: 1 },
      { type: 'tool_result', id: 'tc1', result: {}, isError: false },
      { type: 'tool_result', id: 'tc2', result: {}, isError: true },
    ]);
    expect(t.hasTerminal()).toBe(false);
    expect(t.finalize().totalCostMicros).toBe(0);
    expect(t.finalize().proposalCount).toBe(0);
  });
});
