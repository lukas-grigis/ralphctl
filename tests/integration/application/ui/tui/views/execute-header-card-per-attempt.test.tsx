/**
 * HeaderCard — per-attempt round counter in the active-task focus row (audit L4).
 *
 * `currentTask.genEvalRound` is monotonic across the whole task while `genEvalMaxRounds`
 * (`maxTurns`) caps a single attempt, so the raw ratio overshoots on a 2nd+ attempt (e.g.
 * `round 4/3`). The focus row must fold the round into per-attempt coordinates and surface the
 * attempt counter — `attempt 2/3 · round 1/3` — instead.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { HeaderCard } from '@src/application/ui/tui/views/execute-view-internals/header-card.tsx';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const descriptor = (): SessionDescriptor =>
  ({
    id: 'r-1',
    flowId: 'implement',
    title: 'Implement — Demo',
    status: 'running',
    startedAt: 0,
    trace: [],
  }) as unknown as SessionDescriptor;

const task = (overrides: Partial<TaskBucket>): TaskBucket => ({
  id: 'task-1',
  status: 'running',
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 1,
  ...overrides,
});

const renderHeader = (currentTask: TaskBucket) =>
  render(
    <HeaderCard
      descriptor={descriptor()}
      isRunning={true}
      tasksDone={0}
      tasksTotal={1}
      currentTask={currentTask}
      currentTaskIdx={0}
      currentTaskName="Demo task"
      currentSubStep="generator"
    />
  );

describe('HeaderCard per-attempt round', () => {
  it('shows "attempt 2/3 · round 1/3" on a 2nd attempt instead of overshooting to "round 4/3"', () => {
    const r = renderHeader(task({ genEvalRound: 4, genEvalMaxRounds: 3, genEvalMaxAttempts: 3 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 2/3');
    expect(frame).toContain('round 1/3');
    expect(frame).not.toContain('round 4/3');
    r.unmount();
  });

  it('keeps a clean "round 1/1" for a single-attempt single-turn config (no attempt counter)', () => {
    const r = renderHeader(task({ genEvalRound: 1, genEvalMaxRounds: 1, genEvalMaxAttempts: 1 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 1/1');
    expect(frame).not.toContain('attempt');
    r.unmount();
  });

  it('renders the attempt counter when the attempt cap > 1 even while still on attempt 1', () => {
    // attempt 1 of a 3-attempt run still shows the counter so the operator sees the budget.
    const r = renderHeader(task({ genEvalRound: 2, genEvalMaxRounds: 5, genEvalMaxAttempts: 3 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 1/3');
    expect(frame).toContain('round 2/5');
    r.unmount();
  });

  it('omits the attempt counter on attempt 1 when the attempt cap is unknown', () => {
    const r = renderHeader(task({ genEvalRound: 2, genEvalMaxRounds: 5 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 2/5');
    expect(frame).not.toContain('attempt');
    r.unmount();
  });

  it('falls back to a bare round when no per-attempt cap is known (cannot overshoot)', () => {
    const r = renderHeader(task({ genEvalRound: 3 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 3');
    expect(frame).not.toContain('round 3/');
    r.unmount();
  });

  it('trusts live tracker coords over the division heuristic (the crashed-attempt-1 incident)', () => {
    // Attempt 1 crashed after round 1; attempt 2's first round continues the GLOBAL counter at 2.
    // Live coords say attempt 2 / round 1; the bare division of (2,3) would wrongly read
    // attempt 1 / round 2 — the exact mislabel the operator hit.
    const r = renderHeader(
      task({ genEvalRound: 2, genEvalMaxRounds: 3, genEvalMaxAttempts: 3, attemptN: 2, roundInAttempt: 1 })
    );
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 2/3');
    expect(frame).toContain('round 1/3');
    expect(frame).not.toContain('attempt 1/3');
    expect(frame).not.toContain('round 2/3');
    r.unmount();
  });
});
