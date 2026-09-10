/**
 * Settled-run cursor fallback — once every task has settled (no in-flight bucket), the card
 * cursor must anchor on the FIRST `blocked` task rather than unconditionally the last task in the
 * list. Without this, `computeListWindow` (fed by the cursor) anchors the visible window at the
 * END of the list the instant a run finishes, windowing an early blocked card off-screen behind
 * a dim "N more above" cue — exactly the failure mode this pins down.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const bucket = (id: string, status: TaskBucket['status']): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

describe('TasksPanel — settled cursor anchors on the first blocked task', () => {
  it('keeps an early blocked card inside the window instead of the last card', () => {
    // 5 settled tasks, blocked at index 0 — with a 1-card budget the OLD fallback
    // (length - 1) would show only the LAST completed task; the fix shows the blocked one.
    const bucketed: BucketedExecution = {
      tasks: [
        bucket('t-blocked', 'blocked'),
        bucket('t-2', 'completed'),
        bucket('t-3', 'completed'),
        bucket('t-4', 'completed'),
        bucket('t-5', 'completed'),
      ],
      orphanSignals: [],
    };
    const names = new Map([
      ['t-blocked', 'Stuck on prerequisite'],
      ['t-2', 'Second task'],
      ['t-3', 'Third task'],
      ['t-4', 'Fourth task'],
      ['t-5', 'Last settled task'],
    ]);

    const r = render(<TasksPanel bucketed={bucketed} running={false} nameById={names} maxTasks={1} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Stuck on prerequisite');
    expect(frame).not.toContain('Last settled task');
    r.unmount();
  });

  it('picks the FIRST blocked task when several are blocked', () => {
    const bucketed: BucketedExecution = {
      tasks: [bucket('t-1', 'completed'), bucket('t-blocked-a', 'blocked'), bucket('t-blocked-b', 'blocked')],
      orphanSignals: [],
    };
    const names = new Map([
      ['t-1', 'Completed first'],
      ['t-blocked-a', 'First blocked'],
      ['t-blocked-b', 'Second blocked'],
    ]);

    const r = render(<TasksPanel bucketed={bucketed} running={false} nameById={names} maxTasks={1} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('First blocked');
    expect(frame).not.toContain('Second blocked');
    r.unmount();
  });

  it('auto-expands the first blocked card as the settled summary, not the last card', () => {
    const bucketed: BucketedExecution = {
      tasks: [bucket('t-blocked', 'blocked'), bucket('t-2', 'completed')],
      orphanSignals: [],
    };
    const criteria = new Map([
      ['t-blocked', ['[C1] manual — the blocked-only criterion']],
      ['t-2', ['[C2] manual — the completed-only criterion']],
    ]);

    const r = render(<TasksPanel bucketed={bucketed} running={false} taskCriteriaById={criteria} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('the blocked-only criterion');
    expect(frame).not.toContain('the completed-only criterion');
    r.unmount();
  });

  it('falls back to the last task when nothing is blocked (unchanged pre-existing behaviour)', () => {
    const bucketed: BucketedExecution = {
      tasks: [bucket('t-1', 'completed'), bucket('t-2', 'completed'), bucket('t-3', 'completed')],
      orphanSignals: [],
    };
    const names = new Map([
      ['t-1', 'First task'],
      ['t-2', 'Second task'],
      ['t-3', 'Third and last task'],
    ]);

    const r = render(<TasksPanel bucketed={bucketed} running={false} nameById={names} maxTasks={1} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Third and last task');
    expect(frame).not.toContain('First task');
    r.unmount();
  });
});
