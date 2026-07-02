/**
 * TaskBlock — per-attempt round chip (`RoundAttemptChip`) in the task-panel card header.
 *
 * Mirrors the HeaderCard per-attempt test for the SECOND render surface that shows the counter.
 * `task.genEvalRound` is monotonic across the whole task while `genEvalMaxRounds` (`maxTurns`) caps
 * a single attempt, so the raw ratio overshoots on a 2nd+ attempt (`round 4/3`). The chip must fold
 * the round into per-attempt coordinates, preferring the live tracker-sourced `attemptN` /
 * `roundInAttempt` over the `perAttemptRound` division heuristic.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TaskBlock } from '@src/application/ui/tui/components/tasks-panel-internals/task-row.tsx';
import type { TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const task = (overrides: Partial<TaskBucket>): TaskBucket => ({
  id: 'task-1',
  status: 'running',
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 1,
  ...overrides,
});

const renderChip = (t: TaskBucket) =>
  render(
    <TaskBlock
      task={t}
      running={true}
      display="Demo task"
      maxSignals={10}
      maxSubSteps={10}
      focusedKey={undefined}
      expandedKeys={new Set()}
      scopeId="scope-1"
      sliceStart={0}
      criteriaExpanded={false}
      showEvaluatorFailureUI={false}
      isActive={true}
      firstRun={false}
      cardExpanded={true}
      cardFocused={false}
      nowMs={0}
    />
  );

describe('TaskBlock — RoundAttemptChip per-attempt round', () => {
  it('folds the division heuristic on a 2nd attempt (round 4/3 → attempt 2/3 · round 1/3)', () => {
    const r = renderChip(task({ genEvalRound: 4, genEvalMaxRounds: 3, genEvalMaxAttempts: 3 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 2/3');
    expect(frame).toContain('round 1/3');
    expect(frame).not.toContain('round 4/3');
    r.unmount();
  });

  it('trusts live tracker coords over the division heuristic (the crashed-attempt-1 incident)', () => {
    // Attempt 1 crashed after round 1; attempt 2's first round continues the GLOBAL counter at 2.
    // Live coords say attempt 2 / round 1; the bare division of (2,3) would wrongly read
    // attempt 1 / round 2 — the exact mislabel the operator hit in the task panel.
    const r = renderChip(
      task({ genEvalRound: 2, genEvalMaxRounds: 3, genEvalMaxAttempts: 3, attemptN: 2, roundInAttempt: 1 })
    );
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('attempt 2/3');
    expect(frame).toContain('round 1/3');
    expect(frame).not.toContain('attempt 1/3');
    expect(frame).not.toContain('round 2/3');
    r.unmount();
  });

  it('falls back to a bare round when no per-attempt cap is known (cannot overshoot)', () => {
    const r = renderChip(task({ genEvalRound: 3 }));
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 3');
    expect(frame).not.toContain('round 3/');
    r.unmount();
  });
});
