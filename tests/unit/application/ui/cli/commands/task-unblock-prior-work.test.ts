/**
 * `ralphctl task unblock --prior-work` against a real git repo holding the task's quarantined stash entry:
 * the cause-aware default is applied and printed, the flag overrides it, every probe outcome has its own
 * wording, and `task list` shows the stash and the next-attempt decision.
 */

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { withQuarantinedDiff } from '@src/domain/entity/task-prior-work.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { createFsProjectRepository } from '@src/integration/persistence/project/repository.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createFakeProject, type FakeProject } from '@tests/helpers/fake-project.ts';
import { makeActiveSprint, makeProject, makeRepository, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl task unblock --prior-work', () => {
  let cli: CliHome;
  let repo: FakeProject;

  beforeEach(async () => {
    cli = await createCliHome();
    repo = await createFakeProject({ seed: { 'a.txt': 'one\n' } });
  });

  afterEach(async () => {
    await cli.cleanup();
    await repo.cleanup();
  });

  const taskRepo = () => createFsTaskRepository({ root: cli.paths.dataRoot });

  /** Seed project + sprint + one blocked task; optionally stash a one-file rejected diff under its key. */
  const seed = async (
    opts: { cause?: 'budget-exhausted' | 'generator-self-block'; stash?: boolean; repoPath?: string } = {}
  ) => {
    const project = makeProject({
      repositories: [makeRepository({ path: opts.repoPath ?? repo.path })],
    });
    await createFsProjectRepository({ root: cli.paths.dataRoot }).save(project);
    const sprint = makeActiveSprint();
    await createFsSprintRepository({ root: cli.paths.dataRoot }).save({ ...sprint, projectId: project.id });
    const marked = markTaskBlocked(makeTodoTask({ name: 'Add retry' }), 'attempt budget exhausted', 'own', {
      blockCause: opts.cause ?? 'budget-exhausted',
    });
    if (!marked.ok) throw new Error(marked.error.message);
    const message = quarantineStashMessage(sprint.id, marked.value.id);
    const task: BlockedTask = withQuarantinedDiff(marked.value, message, { files: 1, insertions: 1, deletions: 0 });
    await taskRepo().saveAll(sprint.id, [task]);
    if (opts.stash !== false && opts.repoPath === undefined) {
      await repo.writeFile('a.txt', 'one\ntwo\n');
      await repo.git('stash', 'push', '-u', '-m', message);
    }
    return { sprint, task, message };
  };

  const stored = async (sprintId: Parameters<ReturnType<typeof taskRepo>['findBySprintId']>[0]): Promise<Task> => {
    const r = await taskRepo().findBySprintId(sprintId);
    if (!r.ok) throw new Error(r.error.message);
    return r.value[0] as Task;
  };

  it('applies the cause-aware default, says so, and records it', async () => {
    const { sprint, task, message } = await seed();
    const r = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(task.id)]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        `unblocked task 'Add retry' (${String(task.id)})`,
        `rejected diff in git stash: ${message} — 1 file +1 -0`,
        'next attempt: starts fresh (default after an attempt-budget block); the diff stays in the stash',
        `      to continue from it instead: ralphctl task unblock --sprint ${String(sprint.id)} ${String(task.id)} --prior-work continue`,
        '',
      ].join('\n')
    );
    expect((await stored(sprint.id)).quarantinedDiff?.nextAttempt).toBe('fresh');
    expect(await repo.git('stash', 'list')).toContain(message);
  });

  it('defaults to continue for a self-blocked task', async () => {
    const { sprint, task } = await seed({ cause: 'generator-self-block' });
    const r = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(task.id)]);

    expect(r.stdout).toContain(
      'next attempt: continues from the rejected diff (default after a self-block); it is restored before the first AI turn'
    );
    expect(r.stdout).toContain(`--prior-work fresh`);
    expect((await stored(sprint.id)).quarantinedDiff?.nextAttempt).toBe('continue');
  });

  it('an explicit flag overrides the default and prints no alternative hint', async () => {
    const { sprint, task, message } = await seed();
    const r = await runCliCaptured(cli, [
      'task',
      'unblock',
      '--sprint',
      String(sprint.id),
      String(task.id),
      '--prior-work',
      'continue',
    ]);

    expect(r.stdout).toBe(
      [
        `unblocked task 'Add retry' (${String(task.id)})`,
        `rejected diff in git stash: ${message} — 1 file +1 -0`,
        'next attempt: continues from the rejected diff (--prior-work continue); it is restored before the first AI turn',
        '',
      ].join('\n')
    );
    expect((await stored(sprint.id)).quarantinedDiff?.nextAttempt).toBe('continue');
  });

  it('rejects an invalid value before writing anything', async () => {
    const { sprint, task } = await seed();
    const r = await runCliCaptured(cli, [
      'task',
      'unblock',
      '--sprint',
      String(sprint.id),
      String(task.id),
      '--prior-work',
      'maybe',
    ]);

    expect(r.exitCode).not.toBe(0);
    expect((await stored(sprint.id)).status).toBe('blocked');
  });

  it('notes that the flag has nothing to apply to when the stash entry is gone', async () => {
    const { sprint, task } = await seed({ stash: false });
    const r = await runCliCaptured(cli, [
      'task',
      'unblock',
      '--sprint',
      String(sprint.id),
      String(task.id),
      '--prior-work',
      'fresh',
    ]);

    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(
      'note: no rejected diff in git stash for this task — --prior-work has nothing to apply to'
    );
    expect((await stored(sprint.id)).status).toBe('todo');
  });

  describe('when git cannot be read', () => {
    let notARepo: string;
    beforeEach(async () => {
      notARepo = await realpath(await mkdtemp(join(tmpdir(), 'ralphctl-not-a-repo-')));
    });

    it('warns and unblocks when no flag was given', async () => {
      const { sprint, task } = await seed({ repoPath: notARepo });
      const r = await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(task.id)]);

      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(
        /note: couldn't read git stash \(.+\); a rejected diff there would be restored on the next attempt\n/
      );
      expect((await stored(sprint.id)).status).toBe('todo');
    });

    it('still records an explicit choice, because the stash key is deterministic', async () => {
      const { sprint, task } = await seed({ repoPath: notARepo });
      const r = await runCliCaptured(cli, [
        'task',
        'unblock',
        '--sprint',
        String(sprint.id),
        String(task.id),
        '--prior-work',
        'fresh',
      ]);

      expect(r.stderr).toMatch(/note: couldn't read git stash \(.+\) — recorded --prior-work fresh anyway\n/);
      expect((await stored(sprint.id)).quarantinedDiff?.nextAttempt).toBe('fresh');
    });
  });

  it('lets a todo task change its mind and says what it was', async () => {
    const { sprint, task } = await seed();
    await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(task.id)]);
    const r = await runCliCaptured(cli, [
      'task',
      'unblock',
      '--sprint',
      String(sprint.id),
      String(task.id),
      '--prior-work',
      'continue',
    ]);

    expect(r.stdout).toContain('next attempt: continues from the rejected diff (was: starts fresh)');
    expect((await stored(sprint.id)).quarantinedDiff?.nextAttempt).toBe('continue');
  });

  it('task list shows the stash on a blocked row and the decision on a todo row', async () => {
    const { sprint, task, message } = await seed();
    const blockedList = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(blockedList.stdout).toContain(`       stash: ${message} (1 file +1 -0)`);
    expect(blockedList.stdout).toContain(
      `       recover with: ralphctl task unblock ${String(task.id)} [--prior-work continue|fresh]`
    );

    await runCliCaptured(cli, ['task', 'unblock', '--sprint', String(sprint.id), String(task.id)]);
    const todoList = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
    expect(todoList.stdout).toContain('       next attempt: starts fresh — rejected diff stays in git stash');
  });
});
