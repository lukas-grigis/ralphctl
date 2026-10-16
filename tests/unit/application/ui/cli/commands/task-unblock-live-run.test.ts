/**
 * `ralphctl task unblock` against a sprint a live run holds: the unblock must wait for the run's
 * sprint lock and decide on the task as the run left it — never write its own stale snapshot over
 * the run's final write.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DoneTask } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { makeActiveSprint, makeDoneTask, makeTodoTask } from '@tests/fixtures/domain.ts';
import { holdSprintLock } from '@tests/helpers/hold-flow-lock.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl task unblock — while a run holds the sprint', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('waits for the run and refuses a task the run finished meanwhile', async () => {
    const sprint = makeActiveSprint();
    await createFsSprintRepository({ root: cli.paths.dataRoot }).save(sprint);
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: 'flaky' }), 'verify failed', 'own');
    if (!blocked.ok) throw new Error(blocked.error.message);
    await taskRepo.saveAll(sprint.id, [blocked.value]);

    const run = await holdSprintLock(cli.paths, sprint);
    const unblock = runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(blocked.value.id)]);
    await sleep(300);
    // The run's epilogue: its retry of the task succeeded.
    const finished: DoneTask = { ...makeDoneTask({ name: 'flaky' }), id: blocked.value.id };
    await taskRepo.saveAll(sprint.id, [finished]);
    await run.release();

    const result = await unblock;
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('unblocked task');
    const after = await taskRepo.findById(sprint.id, blocked.value.id);
    expect(after.ok && after.value.status).toBe('done');
  });
});
