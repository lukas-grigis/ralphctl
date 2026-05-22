/**
 * TasksPanel — ETA chip in the active-task header.
 *
 * The chip appends to the existing `· round N/M` row and reads `· ~Xm Ys remaining` (or
 * `· no ETA yet` when the projection has no median). Only the active (first non-completed)
 * task renders an ETA; completed / pending tasks never do.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SprintState, TaskProjection } from '@src/application/ui/tui/components/tasks-projection.ts';

const baseBucket = (overrides: Partial<BucketedExecution['tasks'][number]> = {}): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 2,
      genEvalMaxRounds: 5,
      ...overrides,
    },
  ],
  orphanSignals: [],
});

const sprintStateWithMedian = (taskId: string, medianMs: number | undefined): SprintState => {
  const task: TaskProjection = {
    id: taskId,
    attemptsCount: 1,
    ...(medianMs !== undefined ? { medianRoundDurationMs: medianMs } : {}),
  };
  return { tasks: [task] };
};

describe('TasksPanel ETA chip', () => {
  it('renders a "~Xm Ys remaining" chip from medianRoundDurationMs', () => {
    // Median 30 s × (5 - 2) = 90 s = 1m 30s
    const state = sprintStateWithMedian('task-1', 30_000);
    const r = render(<TasksPanel bucketed={baseBucket()} running={true} sprintState={state} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 2/5');
    expect(frame).toMatch(/~1m\s+30s remaining/);
    r.unmount();
  });

  it('renders "no ETA yet" when the projection has no median (first round of first task)', () => {
    const state = sprintStateWithMedian('task-1', undefined);
    const r = render(<TasksPanel bucketed={baseBucket()} running={true} sprintState={state} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 2/5');
    expect(frame).toContain('no ETA yet');
    r.unmount();
  });

  it('omits ETA when sprintState is not supplied', () => {
    const r = render(<TasksPanel bucketed={baseBucket()} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 2/5');
    expect(frame).not.toContain('remaining');
    expect(frame).not.toContain('no ETA yet');
    r.unmount();
  });

  it('omits ETA on tasks that are not the active one', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'completed',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 3,
          genEvalMaxRounds: 5,
        },
        {
          id: 'task-2',
          status: 'pending',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
          genEvalMaxRounds: 5,
        },
      ],
      orphanSignals: [],
    };
    const state = sprintStateWithMedian('task-1', 30_000);
    const r = render(<TasksPanel bucketed={bucketed} running={true} sprintState={state} />);
    const frame = r.lastFrame() ?? '';

    // task-1 is completed; task-2 is the active non-completed but has no round started yet.
    expect(frame).not.toContain('remaining');
    r.unmount();
  });

  it('omits ETA when the gen-eval cap has already been reached', () => {
    const bucketed = baseBucket({ genEvalRound: 5, genEvalMaxRounds: 5 });
    const state = sprintStateWithMedian('task-1', 30_000);
    const r = render(<TasksPanel bucketed={bucketed} running={true} sprintState={state} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('round 5/5');
    expect(frame).not.toContain('remaining');
    r.unmount();
  });
});
