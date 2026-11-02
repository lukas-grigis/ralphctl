/**
 * `TasksPanelHost` is the one production construction site of `TasksPanel`: the attempt-count /
 * commit-sha chips and the ETA chip only render when the host derives a per-task projection from
 * the polled task entities, so these pin that wiring rather than the panel in isolation.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import { makeDoneTask } from '@tests/fixtures/domain.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

vi.mock('@src/application/ui/tui/runtime/use-unblock-task.ts', () => ({
  useUnblockTask: () => ({ unblockInSprint: vi.fn().mockResolvedValue({ kind: 'cancelled' }) }),
}));

const descriptor: SessionDescriptor = {
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'running',
  startedAt: 0,
  trace: [],
};

// The fixture's single attempt settled after exactly one hour and committed this sha.
const task = (() => {
  const done = makeDoneTask();
  return {
    ...done,
    attempts: done.attempts.map((a) => ({ ...a, commitSha: 'abc1234def56' as CommitSha })),
  } as unknown as typeof done;
})();

const bucket = (patch: Partial<TaskBucket>): BucketedExecution => ({
  tasks: [
    {
      id: String(task.id),
      status: 'completed',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 0,
      ...patch,
    },
  ],
  orphanSignals: [],
});

const mount = (bucketed: BucketedExecution, isRunning: boolean): ReturnType<typeof render> =>
  render(
    <TasksPanelHost
      bucketed={bucketed}
      descriptor={{ ...descriptor, taskNames: new Map([[String(task.id), 'Projected task']]) }}
      isRunning={isRunning}
      maxSignalsPerTask={8}
      maxTasks={10}
      inputActive={true}
      now={0}
      taskState={[task]}
    />
  );

describe('TasksPanelHost — task projection chips', () => {
  it('shows the attempt count and short commit sha on a collapsed card', async () => {
    // A pending sibling takes the auto-expanded active slot, leaving the projected card collapsed.
    const withSibling = bucket({});
    const sibling: TaskBucket = { ...bucket({}).tasks[0]!, id: 'sibling', status: 'pending' };
    const r = mount({ ...withSibling, tasks: [...withSibling.tasks, sibling] }, true);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('Projected task'));
    const line = (r.lastFrame() ?? '').split('\n').find((l) => l.includes('Projected task')) ?? '';

    expect(line).toContain('1×');
    expect(line).toContain('abc1234');
    expect(line).not.toContain('abc1234d');
  });

  it('scales the median attempt time to the rounds left in the cap', async () => {
    // One-hour median attempt over a 5-round cap, 3 rounds left: 36 minutes.
    const r = mount(bucket({ status: 'running', genEvalRound: 2, genEvalMaxRounds: 5 }), true);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('Projected task'));

    expect(r.lastFrame() ?? '').toMatch(/~36m\s+00s remaining/);
  });
});
