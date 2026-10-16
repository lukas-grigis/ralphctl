/**
 * `useUnblockTask` — the seam every TUI unblock binding goes through — against a sprint a live run
 * holds: it waits for the run's sprint lock and decides on the task as the run left it, so the
 * Sprints view's `u` (which has no running-state gate of its own) cannot clobber the run's write.
 */

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { DoneTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { type UnblockOneResult, useUnblockTask } from '@src/application/ui/tui/runtime/use-unblock-task.ts';
import { makeActiveSprint, makeDoneTask, makeTodoTask } from '@tests/fixtures/domain.ts';
import { holdSprintLock } from '@tests/helpers/hold-flow-lock.ts';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const Probe = (props: {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly onDone: (r: UnblockOneResult) => void;
}): null => {
  const { unblockOne } = useUnblockTask();
  useEffect(() => {
    void unblockOne(props.task, props.sprint, undefined).then(props.onDone);
  }, []); // one unblock per mount
  return null;
};

describe('useUnblockTask — while a run holds the sprint', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => app.cleanup());

  it('waits for the run and refuses a task the run finished meanwhile', async () => {
    const sprint = makeActiveSprint();
    await app.deps.sprintRepo.save(sprint);
    const blocked = markTaskBlocked(makeTodoTask({ name: 'flaky' }), 'verify failed', 'own');
    if (!blocked.ok) throw new Error(blocked.error.message);
    await app.deps.taskRepo.saveAll(sprint.id, [blocked.value]);

    const run = await holdSprintLock(app.paths, sprint);
    let outcome: UnblockOneResult | undefined;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const contended = run.contender();
    const onDone = (r: UnblockOneResult): void => {
      outcome = r;
      settled();
    };
    renderView(<Probe task={blocked.value} sprint={sprint} onDone={onDone} />, {
      deps: app.deps,
      initial: { id: 'home' },
    });
    const first = await Promise.race([contended.then(() => 'waiting'), done.then(() => 'finished')]);
    expect(first).toBe('waiting');
    const finished: DoneTask = { ...makeDoneTask({ name: 'flaky' }), id: blocked.value.id };
    await app.deps.taskRepo.saveAll(sprint.id, [finished]);
    await run.release();

    await waitForPredicate(() => outcome !== undefined);
    expect(outcome?.kind).toBe('failed');
    const after = await app.deps.taskRepo.findById(sprint.id, blocked.value.id);
    expect(after.ok && after.value.status).toBe('done');
  });
});
