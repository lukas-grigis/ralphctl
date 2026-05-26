import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { makeDraftSprint, makeDoneTask, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl task', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  describe('list', () => {
    it('reports the empty state when no plan has run yet', async () => {
      const sprint = makeDraftSprint();
      const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no tasks yet');
    });

    it('lists tasks ordered by their order field', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      const t1 = makeTodoTask({ name: 'first', order: 1 });
      const t2 = makeTodoTask({ name: 'second', order: 2 });
      await repo.saveAll(sprint.id, [t1, t2]);

      const result = await runCliCaptured(cli, ['task', 'list', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('first');
      expect(result.stdout).toContain('second');
      expect(result.stdout).toContain('todo');
    });

    it('exits 1 on malformed sprint id', async () => {
      const result = await runCliCaptured(cli, ['task', 'list', '--sprint', 'nope']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid sprint id');
    });
  });

  describe('show <taskId>', () => {
    it('prints the task as JSON', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      const task = makeTodoTask({ name: 'concrete', order: 1 });
      await repo.saveAll(sprint.id, [task]);

      const result = await runCliCaptured(cli, ['task', 'show', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { readonly id: string; readonly name: string };
      expect(parsed.id).toBe(String(task.id));
      expect(parsed.name).toBe('concrete');
    });

    it('exits 1 when the task does not exist for that sprint', async () => {
      const sprint = makeDraftSprint();
      const result = await runCliCaptured(cli, [
        'task',
        'show',
        '01900000-0000-7000-8000-00000000ffff',
        '--sprint',
        String(sprint.id),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });
  });

  describe('unblock <taskId>', () => {
    it('flips a blocked task back to todo and persists', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      const blocked = markTaskBlocked(makeTodoTask({ name: 'wedged' }), 'flaky verify');
      if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
      await repo.saveAll(sprint.id, [blocked.value]);

      const result = await runCliCaptured(cli, [
        'task',
        'unblock',
        String(blocked.value.id),
        '--sprint',
        String(sprint.id),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('unblocked task');
      expect(result.stdout).toContain('wedged');

      const reloaded = await repo.findById(sprint.id, blocked.value.id);
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) return;
      expect(reloaded.value.status).toBe('todo');
    });

    it('idempotent — already-todo task is a no-op success', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      const todo = makeTodoTask({ name: 'fine' });
      await repo.saveAll(sprint.id, [todo]);

      const result = await runCliCaptured(cli, ['task', 'unblock', String(todo.id), '--sprint', String(sprint.id)]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('unblocked task');
    });

    it('exits 1 when the task is done (cannot unblock a done task)', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      const done = makeDoneTask();
      await repo.saveAll(sprint.id, [done]);

      const result = await runCliCaptured(cli, ['task', 'unblock', String(done.id), '--sprint', String(sprint.id)]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('error:');
    });

    it('exits 1 on malformed task id', async () => {
      const sprint = makeDraftSprint();
      const result = await runCliCaptured(cli, ['task', 'unblock', 'nope', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid task id');
    });
  });
});
