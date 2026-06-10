/**
 * Done-with-warning surfacing in the Tasks list. The attempt-card already renders attempt
 * warnings in the sprint-detail view; the tasks-panel task row historically showed the warning
 * glyph only for a blocked reason. A task that settled `done` but whose FINAL attempt carries an
 * `AttemptWarning` must now render the warning glyph + a one-line summary so a flagged completion
 * never reads as a clean pass. The live TaskBucket is trace-derived and carries no warning, so the
 * host threads a `warningSummaryById` map from the polled entities (mirrors `blockedReasonById`).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';

const bucket = (id: string, status: TaskBucket['status']): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const ID = '01933fbb-0000-7000-8000-000000000010';

describe('TasksPanel done-with-warning', () => {
  it('renders the warning glyph + summary under a completed task with a final-attempt warning', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'completed')], orphanSignals: [] };
    const summaryById = new Map([[ID, 'done with warning: evaluator plateaued on C1']]);
    const r = render(<TasksPanel bucketed={bucketed} running={false} warningSummaryById={summaryById} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.warningGlyph);
    expect(frame).toContain('done with warning');
    expect(frame).toContain('evaluator plateaued on C1');
    r.unmount();
  });

  it('shows no warning line for a completed task that is not in the map (clean pass)', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'completed')], orphanSignals: [] };
    const r = render(<TasksPanel bucketed={bucketed} running={false} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('done with warning');
    r.unmount();
  });

  it('does not render the warning line for a non-completed task even if a summary is supplied', () => {
    // A summary keyed to a still-running task must not surface — the warning belongs to a settled
    // done card. The row gates on `task.status === 'completed'`.
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'running')], orphanSignals: [] };
    const summaryById = new Map([[ID, 'done with warning: evaluator plateaued on C1']]);
    const r = render(<TasksPanel bucketed={bucketed} running={false} warningSummaryById={summaryById} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('done with warning');
    r.unmount();
  });
});
