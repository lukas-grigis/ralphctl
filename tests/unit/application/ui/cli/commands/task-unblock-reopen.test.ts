/**
 * `ralphctl task unblock` reopens the sprint so the revived work is runnable again — a `review`
 * sprint to `active`, and a `done` one through `review` first. That second hop is subject to the
 * single-active-per-project invariant: `done` does not hold the project, so a closed sprint can sit
 * next to a live peer, and carrying it back into `review` would put two sprints of one project on
 * the shared working tree (the cross-process repo lock is keyed per sprint dir, not per project).
 * `ralphctl sprint reopen` already refuses that; unblock must not perform it silently — and, since
 * the reopen is best-effort while the unblock is not, it has to SAY that the sprint stayed closed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { makeActiveSprint, makeDoneSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl task unblock — sprint reopen', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  const seedBlockedTask = async (sprintId: SprintId): Promise<BlockedTask> => {
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: 'stuck-task' }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await taskRepo.saveAll(sprintId, [blocked.value]);
    return blocked.value;
  };

  it('reopens a done sprint to active when no peer holds the project', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const done = makeDoneSprint();
    await sprintRepo.save(done);
    const blocked = await seedBlockedTask(done.id);

    const result = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(done.id), String(blocked.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`unblocked task 'stuck-task'`);
    expect(result.stderr).not.toContain('note:');

    const reloaded = await sprintRepo.findById(done.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('active');
  });

  // The name echoed back is planner-authored prose off the same generator as the blocked reason —
  // see `formatTaskLine` in commands/task.ts. It reaches the terminal here too.
  it('strips terminal escape sequences out of the task name it echoes back', async () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const active = makeActiveSprint();
    await sprintRepo.save(active);
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const blocked = markTaskBlocked(makeTodoTask({ name: `${esc}]0;pwned${bel}stuck-task` }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await taskRepo.saveAll(active.id, [blocked.value]);

    const result = await runCliCaptured(cli, [
      'task',
      'unblock',
      '--sprint',
      String(active.id),
      String(blocked.value.id),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(esc);
    expect(result.stdout).not.toContain(bel);
    expect(result.stdout).toContain(`unblocked task ']0;pwnedstuck-task'`);
  });

  it('revives the task but leaves the sprint closed — and says so — when a peer is already active', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const done = makeDoneSprint();
    const activePeer = makeActiveSprint();
    await sprintRepo.save(done);
    await sprintRepo.save(activePeer);
    const blocked = await seedBlockedTask(done.id);

    const result = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(done.id), String(blocked.id)]);

    // The unblock itself succeeds: the reopen is best-effort, the task revival is not.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`unblocked task 'stuck-task'`);
    // ...and the operator is told the sprint did NOT reopen, which peer holds the project, and
    // what to do about it — this is the whole difference from reopening silently.
    expect(result.stderr).toContain('note:');
    expect(result.stderr).toContain(String(activePeer.slug));
    expect(result.stderr).toContain('ralphctl sprint close');

    const reloadedDone = await sprintRepo.findById(done.id);
    expect(reloadedDone.ok).toBe(true);
    if (reloadedDone.ok) expect(reloadedDone.value.status).toBe('done');
    const reloadedPeer = await sprintRepo.findById(activePeer.id);
    expect(reloadedPeer.ok).toBe(true);
    if (reloadedPeer.ok) expect(reloadedPeer.value.status).toBe('active');

    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const tasks = await taskRepo.findBySprintId(done.id);
    expect(tasks.ok).toBe(true);
    if (tasks.ok) expect(tasks.value[0]?.status).toBe('todo');
  });
});
