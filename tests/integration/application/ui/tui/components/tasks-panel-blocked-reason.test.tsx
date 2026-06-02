/**
 * Blocked-reason surfacing. A blocked task's card must show WHY it blocked (the entity's
 * blockedReason) instead of a bare `blocked` status — the live TaskBucket status is trace-derived
 * and carries no reason, so the host threads a blockedReasonById map from the polled entities.
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

const ID = '01933fbb-0000-7000-8000-000000000001';

describe('TasksPanel blocked-reason', () => {
  it('renders the blockedReason under a blocked task card', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'failed')], orphanSignals: [] };
    const reasonById = new Map([[ID, 'blocked upstream — prerequisite not done: Foundation (blocked)']]);
    const r = render(<TasksPanel bucketed={bucketed} running={false} blockedReasonById={reasonById} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('blocked upstream');
    expect(frame).toContain('prerequisite not done');
    r.unmount();
  });

  it('shows no reason line when none is supplied', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'failed')], orphanSignals: [] };
    const r = render(<TasksPanel bucketed={bucketed} running={false} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('prerequisite not done');
    r.unmount();
  });
});
