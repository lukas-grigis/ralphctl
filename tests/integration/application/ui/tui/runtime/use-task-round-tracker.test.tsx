/**
 * Verify the per-task gen-eval round tracker hook used by the execute view to drive the
 * `round N/M` indicator. The hook must:
 *  - record the latest `roundN`/`totalCap` per taskId,
 *  - never regress on a late-arriving older event (monotonic),
 *  - publish a fresh Map reference on update so React's referential equality triggers
 *    re-renders of consumers,
 *  - coalesce a burst of publishes into a single React commit per flush window,
 *  - NOT allocate a new Map (no phantom re-render) when an entire batch is stale.
 *
 * REPO CONVENTION (see use-coalesced-buffer.test.tsx): no `vi.useFakeTimers()` inside an
 * ink-testing-library render — Ink's reconciler and the coalescer's real interval run on the real
 * event loop. We pass a short `flushMs` via the hook's test-only escape hatch and drain past it.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import {
  TASK_ROUND_CAP,
  type TaskRound,
  useTaskRoundTracker,
} from '@src/application/ui/tui/runtime/use-task-round-tracker.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

/** Short coalescer window for tests; drain past it with DRAIN_MS. */
const FLUSH_MS = 20;
const DRAIN_MS = 60;

const drain = (ms: number = DRAIN_MS): Promise<void> => new Promise((res) => setTimeout(res, ms));

type Rounds = ReadonlyMap<string, TaskRound>;

const Probe = ({
  bus,
  onState,
  onRender,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState?: (rounds: Rounds) => void;
  readonly onRender?: () => void;
}): React.JSX.Element => {
  const rounds = useTaskRoundTracker(bus, { flushMs: FLUSH_MS });
  onState?.(rounds);
  onRender?.();
  return <Text>tasks={rounds.size}</Text>;
};

describe('useTaskRoundTracker', () => {
  it('records the latest round per task across publishes', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 2, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't2', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await drain();

    // attemptN=1 throughout, so roundInAttempt tracks roundN (attempt anchored at round 1).
    expect(last.get('t1')).toEqual({ roundN: 2, totalCap: 5, attemptN: 1, roundInAttempt: 2 });
    expect(last.get('t2')).toEqual({ roundN: 1, totalCap: 5, attemptN: 1, roundInAttempt: 1 });
    r.unmount();
  });

  it('never regresses the round high-water on a late-arriving older event', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 3, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 2, totalCap: 5, at: NOW });
    await drain();

    // First-seen event is round 3 with no prior state, so the attempt anchors there → roundInAttempt 1.
    expect(last.get('t1')).toEqual({ roundN: 3, totalCap: 5, attemptN: 1, roundInAttempt: 1 });
    r.unmount();
  });

  it('resets roundInAttempt to 1 when a new attempt continues the global round counter', async () => {
    // Reproduces the real incident: attempt 1 crashed after round 1 (global round 1); attempt 2's
    // first round continues the GLOBAL counter at round 2 — but must display as attempt 2, round 1,
    // not attempt 1, round 2 (which the old division heuristic produced).
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    // No round-2-of-attempt-1 event — attempt 1 crashed. Attempt 2 opens at global round 2.
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 2, roundN: 2, totalCap: 5, at: NOW });
    await drain();

    expect(last.get('t1')).toEqual({ roundN: 2, totalCap: 5, attemptN: 2, roundInAttempt: 1 });
    r.unmount();
  });

  it('ignores other AppEvent types', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'chain-started', chainId: 'c1', flowId: 'implement', at: NOW });
    bus.publish({ type: 'log', level: 'info', message: 'noise', at: NOW });
    await drain();

    expect(last.size).toBe(0);
    r.unmount();
  });

  it('coalesces a burst of publishes in one window into a single React commit', async () => {
    const bus = createInMemoryEventBus();
    let renders = 0;
    const r = render(<Probe bus={bus} onRender={() => (renders += 1)} />);

    // Let the mount effect attach the subscription before flooding.
    await drain(5);
    const baseline = renders;

    // 40 distinct task events in one sub-flush window must collapse to ~1 commit, not 40.
    for (let i = 0; i < 40; i += 1) {
      bus.publish({
        type: 'task-round-started',
        taskId: `burst-${String(i)}`,
        attemptN: 1,
        roundN: 1,
        totalCap: 5,
        at: NOW,
      });
    }
    await drain();

    const commits = renders - baseline;
    expect(commits).toBeGreaterThanOrEqual(1);
    expect(commits).toBeLessThanOrEqual(2);
    r.unmount();
  });

  it('does not allocate a new Map (no phantom render) when an entire batch is stale', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    let renders = 0;
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} onRender={() => (renders += 1)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 3, totalCap: 5, at: NOW });
    await drain();
    const afterFirst = last;
    const rendersAfterFirst = renders;

    // A whole batch below the high-water mark: the reducer must return `prev` unchanged so React
    // sees the same reference and bails the commit.
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 2, totalCap: 5, at: NOW });
    await drain();

    // The strong guard: the SAME Map reference is returned — an unconditional clone (the regression
    // this protects against) would surface a new reference here and fail.
    expect(last).toBe(afterFirst);
    // Commit-bailout is bounded: returning identical state lets React bail, though it may re-run the
    // render function at most once before doing so (documented behaviour) — never a storm.
    expect(renders - rendersAfterFirst).toBeLessThanOrEqual(1);
    r.unmount();
  });

  it('caps retained tasks at TASK_ROUND_CAP and drops the oldest on a single-window overflow', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
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
    await drain();

    expect(last.size).toBe(TASK_ROUND_CAP);
    // The `overflow` oldest taskIds were dropped; the most recent TASK_ROUND_CAP remain.
    expect(last.has('task-0')).toBe(false);
    expect(last.has(`task-${String(overflow - 1)}`)).toBe(false);
    expect(last.has(`task-${String(overflow)}`)).toBe(true);
    expect(last.has(`task-${String(total - 1)}`)).toBe(true);
    r.unmount();
  });

  it('evicts the oldest entries via the Map-level LRU when a later batch pushes past the cap', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    // Batch 1: fill to (cap - 10) distinct tasks, each comfortably under the per-window buffer cap
    // so nothing is buffer-dropped — the Map accumulates 490 entries.
    const firstBatch = TASK_ROUND_CAP - 10;
    for (let i = 0; i < firstBatch; i += 1) {
      bus.publish({
        type: 'task-round-started',
        taskId: `a-${String(i)}`,
        attemptN: 1,
        roundN: 1,
        totalCap: 5,
        at: NOW,
      });
    }
    await drain();
    expect(last.size).toBe(firstBatch);

    // Batch 2: 20 brand-new tasks fold onto the existing 490 → 510, so the Map-level trim must
    // fire and evict the 10 oldest from batch 1 (a-0..a-9). This is the path the single-window
    // test cannot reach (there the buffer pre-caps before onFlush ever sees an over-cap batch).
    for (let i = 0; i < 20; i += 1) {
      bus.publish({
        type: 'task-round-started',
        taskId: `b-${String(i)}`,
        attemptN: 1,
        roundN: 1,
        totalCap: 5,
        at: NOW,
      });
    }
    await drain();

    expect(last.size).toBe(TASK_ROUND_CAP);
    expect(last.has('a-0')).toBe(false); // oldest evicted
    expect(last.has('a-9')).toBe(false); // 10 oldest evicted
    expect(last.has('a-10')).toBe(true); // 11th-oldest survives
    expect(last.has('b-0')).toBe(true); // newest all retained
    expect(last.has('b-19')).toBe(true);
    r.unmount();
  });

  it('releases the bus subscription on unmount so post-unmount publishes are ignored', async () => {
    const bus = createInMemoryEventBus();
    let last: Rounds = new Map();
    const r = render(<Probe bus={bus} onState={(rounds) => (last = rounds)} />);

    bus.publish({ type: 'task-round-started', taskId: 't1', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await drain();
    expect(last.size).toBe(1);

    r.unmount();

    // Snapshot what the component last saw, then publish more events. If the subscription had
    // leaked the hook would still call setState and update `last`; we assert it does not.
    const snapshot = last;
    bus.publish({ type: 'task-round-started', taskId: 't2', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    bus.publish({ type: 'task-round-started', taskId: 't3', attemptN: 1, roundN: 1, totalCap: 5, at: NOW });
    await drain();

    expect(last).toBe(snapshot);
    expect(last.has('t2')).toBe(false);
    expect(last.has('t3')).toBe(false);
  });
});
