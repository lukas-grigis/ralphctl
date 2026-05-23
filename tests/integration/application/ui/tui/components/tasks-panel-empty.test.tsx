/**
 * TasksPanel — empty / first-run states.
 *
 * Two pre-signal states:
 *   1. 0 tasks → "Tasks panel empty · Run plan to generate tasks" (single dimmed line).
 *   2. N tasks, 0 signals → kinds bar suppressed (it already is — verified here) AND a
 *      `waiting for first attempt…` line below the active task's spinner.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const emptyBucket: BucketedExecution = { tasks: [], orphanSignals: [] };

describe('TasksPanel empty + first-run states', () => {
  it('renders the empty-panel hint when there are no tasks or orphan signals', () => {
    const r = render(<TasksPanel bucketed={emptyBucket} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Tasks panel empty');
    expect(frame).toContain('Run plan to generate tasks');
    r.unmount();
  });

  it('renders "waiting for first attempt…" under the active task spinner when no signal has fired yet', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('waiting for first attempt…');
    // The kinds bar would emit "kinds:" — it must be suppressed at first-run.
    expect(frame).not.toContain('kinds:');
    r.unmount();
  });

  it('does NOT render the first-run waiting line once any signal has landed', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [
            {
              type: 'change',
              text: 'first change',
              timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString() as never,
            },
          ],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('waiting for first attempt');
    // Now that a signal has arrived, the kinds bar should surface its label.
    expect(frame).toContain('kinds:');
    r.unmount();
  });

  it('first-run waiting line attaches to the active (running) task, not completed ones', () => {
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'completed',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
        {
          id: 'task-2',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('waiting for first attempt…');
    r.unmount();
  });
});
