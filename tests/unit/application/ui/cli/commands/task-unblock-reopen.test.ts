/**
 * `ralphctl task unblock` reopens the sprint so the revived work is runnable again — a `review`
 * sprint to `active`, and a `done` one through `review` first. That second hop is subject to the
 * single-active-per-project invariant: `done` does not hold the project, so a closed sprint can sit
 * next to a live peer, and carrying it back into `review` would put two sprints of one project on
 * the shared working tree (the cross-process repo lock is keyed per sprint dir, not per project).
 * `ralphctl sprint reopen` already refuses that; unblock must not perform it silently — and, since
 * the reopen is best-effort while the unblock is not, it has to SAY that the sprint stayed closed.
 */

import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockedTask } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { makeActiveSprint, makeDoneSprint, makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
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
    // A closed sprint coming back is a state change the operator must see, not just a log line.
    expect(result.stdout).toContain(`reopened sprint '${String(done.slug)}' (${String(done.id)}) done → active`);
    expect(result.stderr).not.toContain('note:');

    const reloaded = await sprintRepo.findById(done.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('active');
  });

  // Closing a sprint with `todo` work left is a legitimate descope; an unblock that revives
  // nothing (a wrong id, a scripted retry) must not undo it.
  it('leaves a done sprint closed when the task is already todo', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const done = makeDoneSprint();
    await sprintRepo.save(done);
    const todo = makeTodoTask({ name: 'descoped-task' });
    await createFsTaskRepository({ root: cli.paths.dataRoot }).saveAll(done.id, [todo]);

    const result = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(done.id), String(todo.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`unblocked task 'descoped-task'`);
    expect(result.stdout).not.toContain('reopened');

    const reloaded = await sprintRepo.findById(done.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('done');
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
    // Re-running unblock on the now-todo task does not reopen a closed sprint, so the note has to
    // name the two commands that do, in order.
    expect(result.stderr).toContain(`ralphctl sprint reopen ${String(done.id)}`);
    expect(result.stderr).toContain(`ralphctl task unblock --sprint ${String(done.id)} ${String(blocked.id)}`);
    expect(result.stdout).not.toContain('reopened');

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

  // A todo task left on a `review` sprint (an earlier reopen stopped short of `active`) whose
  // retried review → active hop fails AGAIN: nothing moved, so the CLI must not print
  // "reopened … review → review". A read-only sprint dir makes the sprint save fail for real.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says the sprint is still review when the retried reopen fails again',
    async () => {
      const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
      const review = makeReviewSprint();
      await sprintRepo.save(review);
      const todo = makeTodoTask({ name: 'stranded-task' });
      await createFsTaskRepository({ root: cli.paths.dataRoot }).saveAll(review.id, [todo]);
      const sprintsDir = join(String(cli.paths.dataRoot), 'sprints');
      const sprintDirName = (await readdir(sprintsDir)).find((d) => d.startsWith(String(review.id)));
      if (sprintDirName === undefined) throw new Error('fixture: sprint dir not found');
      const sprintDir = join(sprintsDir, sprintDirName);
      await chmod(sprintDir, 0o555);
      try {
        const result = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(review.id), String(todo.id)]);
        expect(result.stdout).not.toContain('reopened sprint');
        expect(result.stdout).toContain(`sprint '${String(review.slug)}' (${String(review.id)}) is still review`);
        expect(result.stderr).toContain('the review → active step did not persist');
      } finally {
        await chmod(sprintDir, 0o755);
      }
    }
  );
});
