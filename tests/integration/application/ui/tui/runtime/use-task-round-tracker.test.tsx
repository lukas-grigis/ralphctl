/**
 * Verify the per-task gen-eval round tracker hook used by the execute view to drive the
 * `round N/M` indicator. The hook must:
 *  - record the latest `roundN`/`totalCap` per taskId,
 *  - never regress on a late-arriving older event (monotonic),
 *  - publish a fresh Map reference on update so React's referential equality triggers
 *    re-renders of consumers.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { TASK_ROUND_CAP, useTaskRoundTracker } from '@src/application/ui/tui/runtime/use-task-round-tracker.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const Probe = ({
  bus,
  onState,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState: (rounds: ReadonlyMap<string, { roundN: number; totalCap: number }>) => void;
}): React.JSX.Element => {
  const rounds = useTaskRoundTracker(bus);
  onState(rounds);
  return <Text>tasks={rounds.size}</Text>;
};

describe('useTaskRoundTracker', () => {
  it('records the latest round per task across publishes', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, { roundN: number; totalCap: number }> = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 2, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't2', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.get('t1')).toEqual({ roundN: 2, totalCap: 5 });
    expect(last.get('t2')).toEqual({ roundN: 1, totalCap: 5 });
    r.unmount();
  });

  it('never regresses the round high-water on a late-arriving older event', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, { roundN: number; totalCap: number }> = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 3, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 2, totalCap: 5, at: NOW });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.get('t1')).toEqual({ roundN: 3, totalCap: 5 });
    r.unmount();
  });

  it('ignores other AppEvent types', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, { roundN: number; totalCap: number }> = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'chain-started', chainId: 'c1', flowId: 'implement', at: NOW });
    bus.publish({ type: 'log', level: 'info', message: 'noise', at: NOW });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.size).toBe(0);
    r.unmount();
  });

  it('caps retained tasks at TASK_ROUND_CAP and evicts the oldest on overflow', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, { roundN: number; totalCap: number }> = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    const overflow = 50;
    const total = TASK_ROUND_CAP + overflow;
    for (let i = 0; i < total; i += 1) {
      bus.publish({
        type: 'task-round-started',
        taskId: `task-${String(i)}`,
        attemptN: 1,
        roundN: 1,
        totalCap: 5,
        at: NOW,
      });
    }
    await new Promise((res) => setTimeout(res, 5));

    expect(last.size).toBe(TASK_ROUND_CAP);
    // The `overflow` oldest taskIds were evicted; the most recent TASK_ROUND_CAP remain.
    expect(last.has('task-0')).toBe(false);
    expect(last.has(`task-${String(overflow - 1)}`)).toBe(false);
    expect(last.has(`task-${String(overflow)}`)).toBe(true);
    expect(last.has(`task-${String(total - 1)}`)).toBe(true);
    r.unmount();
  });

  it('releases the bus subscription on unmount so post-unmount publishes are ignored', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, { roundN: number; totalCap: number }> = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await new Promise((res) => setTimeout(res, 5));
    expect(last.size).toBe(1);

    r.unmount();

    // Snapshot what the component last saw, then publish more events. If the subscription had
    // leaked the hook would still call setState and update `last`; we assert it does not.
    const snapshot = last;
    bus.publish({ type: 'task-round-started', taskId: 't2', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't3', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await new Promise((res) => setTimeout(res, 5));

    expect(last).toBe(snapshot);
    expect(last.has('t2')).toBe(false);
    expect(last.has('t3')).toBe(false);
  });
});
