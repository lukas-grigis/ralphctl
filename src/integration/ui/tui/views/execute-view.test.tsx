/**
 * ExecuteView state reducer tests — verify that HarnessEvents translate into
 * the expected view-state mutations (running/blocked sets, activity map,
 * rate-limit banner). Rendering/execution flow is exercised manually; this
 * keeps the reducer honest in isolation.
 */

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@src/business/ports/signal-bus.ts';
import { initialState, reduceEvents } from './execute-view.tsx';

describe('reduceEvents', () => {
  it('adds task-started ids to the running set', () => {
    const state = initialState();
    const events: HarnessEvent[] = [
      { type: 'task-started', sprintId: 's1', taskId: 't1', taskName: 'Alpha', timestamp: new Date() },
    ];
    const next = reduceEvents(state, events);
    expect(next.running.has('t1')).toBe(true);
  });

  it('removes task-finished ids from running and records blocked/failed', () => {
    const started = reduceEvents(initialState(), [
      { type: 'task-started', sprintId: 's1', taskId: 't1', taskName: 'Alpha', timestamp: new Date() },
    ]);
    const finished = reduceEvents(started, [
      { type: 'task-finished', sprintId: 's1', taskId: 't1', status: 'blocked', timestamp: new Date() },
    ]);
    expect(finished.running.has('t1')).toBe(false);
    expect(finished.blocked.has('t1')).toBe(true);
  });

  it('updates activity map from progress signals', () => {
    const next = reduceEvents(initialState(), [
      {
        type: 'signal',
        ctx: { sprintId: 's1', taskId: 't1' },
        signal: { type: 'progress', summary: 'wrote index.ts', timestamp: new Date() },
      },
    ]);
    expect(next.activity.get('t1')).toBe('wrote index.ts');
  });

  it('sets rateLimit on pause and clears it on resume', () => {
    const paused = reduceEvents(initialState(), [
      { type: 'rate-limit-paused', delayMs: 30_000, timestamp: new Date() },
    ]);
    expect(paused.rateLimit).not.toBeNull();
    expect(paused.rateLimit?.delayMs).toBe(30_000);

    const resumed = reduceEvents(paused, [{ type: 'rate-limit-resumed', timestamp: new Date() }]);
    expect(resumed.rateLimit).toBeNull();
  });
});
