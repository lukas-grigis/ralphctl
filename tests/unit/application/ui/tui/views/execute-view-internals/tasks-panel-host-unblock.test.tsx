/**
 * `TasksPanelHost`'s `u` unblock wiring — derives `blockedTaskIds` from the same polled entities
 * as `blockedReasonById`, and calls `useUnblockTask` with the matching `Task` entity + the run's
 * own pinned sprint when the operator presses `u` on the FOCUSED card. The affordance is live only
 * once the run has SETTLED (`isRunning={false}`) — `unblockTaskUseCase`'s own docblock forbids
 * running its cascade path concurrently with an active Implement run, and the run's own epilogue
 * would silently overwrite a mid-run unblock with its stale in-memory snapshot regardless — so a
 * live run must force the chord inert, not merely race it.
 *
 * `useUnblockTask` is mocked so this stays a fast, dependency-free unit test — the use case's own
 * behaviour (archiving, cascade-unblock, sprint reopen) belongs to `unblock-task.ts`'s own suite,
 * not this wiring layer.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { SprintId as SprintIdValue } from '@src/domain/value/id/sprint-id.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const mockUnblock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true, value: undefined }));
vi.mock('@src/application/ui/tui/runtime/use-unblock-task.ts', () => ({
  useUnblockTask: () => mockUnblock,
}));

const bucket = (id: string, status: TaskBucket['status']): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const makeFixture = () => {
  const todo = makeTodoTask({ name: 'Fix the thing' });
  const blockedResult = markTaskBlocked(todo, 'stuck on prerequisite', 'upstream');
  if (!blockedResult.ok) throw new Error(`fixture setup failed: ${blockedResult.error.message}`);
  const blockedTask = blockedResult.value;
  const runningTask = makeInProgressTaskWithRunningAttempt();

  const bucketed: BucketedExecution = {
    tasks: [bucket(String(blockedTask.id), 'blocked'), bucket(String(runningTask.id), 'running')],
    orphanSignals: [],
  };
  return { blockedTask, runningTask, bucketed };
};

const makeDescriptor = (pinnedSprintId: SprintId | undefined): SessionDescriptor => ({
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'running',
  startedAt: 0,
  trace: [],
  ...(pinnedSprintId !== undefined ? { pinnedSprintId } : {}),
});

describe('TasksPanelHost — u unblock wiring', () => {
  it('calls unblockTask with the focused blocked task and the pinned sprint once the run has settled', async () => {
    mockUnblock.mockClear();
    const { blockedTask, runningTask, bucketed } = makeFixture();
    const sprintId = SprintIdValue.generate();
    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={makeDescriptor(sprintId)}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[blockedTask, runningTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('blocked'));

    // The cursor defaults to the ACTIVE (running) card — move up onto the blocked one first.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('u');
    await waitForPredicate(() => mockUnblock.mock.calls.length === 1);

    expect(mockUnblock).toHaveBeenCalledWith(blockedTask, sprintId);
    r.unmount();
  });

  // Regression for the silent-revert defect: pressing `u` while the chain is still running used
  // to fire the use case anyway, and the implement epilogue's end-of-run `saveTasksLeaf` (a
  // wholesale rewrite from its own stale in-memory task snapshot) would clobber the revive the
  // moment the run settled — the operator's fix silently undone with no error, no message, and
  // the card flipping todo→blocked on the next poll reading as the harness re-blocking it.
  it('does NOT call unblockTask while the run is still live, even when focused on the blocked card', async () => {
    mockUnblock.mockClear();
    const { blockedTask, runningTask, bucketed } = makeFixture();
    const sprintId = SprintIdValue.generate();
    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={makeDescriptor(sprintId)}
        isRunning={true}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[blockedTask, runningTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('blocked'));

    // Move onto the blocked card exactly as the settled-run test does above.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('u');
    await tick(50);

    expect(mockUnblock).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is inert on a card that is not blocked', async () => {
    mockUnblock.mockClear();
    const { blockedTask, runningTask, bucketed } = makeFixture();
    const sprintId = SprintIdValue.generate();
    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={makeDescriptor(sprintId)}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[blockedTask, runningTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('blocked'));

    // Cursor stays on the active (running, non-blocked) card by default.
    r.stdin.write('u');
    await tick(50);

    expect(mockUnblock).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is a safe no-op when the session has no pinned sprint', async () => {
    mockUnblock.mockClear();
    const { blockedTask, runningTask, bucketed } = makeFixture();
    const r = render(
      <TasksPanelHost
        bucketed={bucketed}
        descriptor={makeDescriptor(undefined)}
        isRunning={false}
        maxSignalsPerTask={8}
        maxTasks={10}
        inputActive={true}
        now={0}
        taskState={[blockedTask, runningTask]}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('blocked'));

    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('u');
    await tick(50);

    expect(mockUnblock).not.toHaveBeenCalled();
    r.unmount();
  });
});
