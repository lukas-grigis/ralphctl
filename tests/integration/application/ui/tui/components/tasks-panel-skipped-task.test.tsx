/**
 * A dependency-blocked (bucket status `skipped`) task must render as skipped and must NOT hold
 * the panel's active-card anchor: the anchor auto-expands the card the operator should be
 * watching, and a task blocked upstream sits early in the list while later tasks actually run.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const BLOCKED = '01933fbb-0000-7000-8000-000000000001';
const RUNNING = '01933fbb-0000-7000-8000-000000000002';

const bucket = (id: string, status: TaskBucket['status'], subSteps: TaskBucket['subSteps']): TaskBucket => ({
  id,
  status,
  subSteps,
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const bucketed: BucketedExecution = {
  tasks: [
    bucket(BLOCKED, 'skipped', [
      { leafName: 'dependency-gate', status: 'completed', durationMs: 2 },
      { leafName: 'task-body', status: 'skipped', durationMs: 0 },
    ]),
    bucket(RUNNING, 'running', [{ leafName: 'generator', status: 'completed', durationMs: 40 }]),
  ],
  orphanSignals: [],
};

const names = new Map([
  [BLOCKED, 'Blocked upstream task'],
  [RUNNING, 'Live task'],
]);

describe('TasksPanel — dependency-blocked task', () => {
  it('labels the blocked task `skipped`, never `running`', () => {
    const r = render(<TasksPanel bucketed={bucketed} running nameById={names} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('Blocked upstream task');
    expect(frame).toContain('skipped');
    r.unmount();
  });

  it('anchors the auto-expanded active card on the running task, not the blocked one', () => {
    const r = render(<TasksPanel bucketed={bucketed} running nameById={names} />);
    const frame = r.lastFrame() ?? '';

    // The active card is the only one expanded on first paint, so its sub-steps are visible
    // while the blocked card's stay collapsed.
    expect(frame).toContain('generator');
    expect(frame).not.toContain('dependency-gate');
    r.unmount();
  });
});
