import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createLastSelectionStore } from '@src/integration/persistence/selection/last-selection-store.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { recordRunningAttemptEvaluation, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { makeDoneTask, makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

const ATTEMPT_STARTED_AT = '2026-08-17T09:00:00.000Z' as IsoTimestamp;

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

    it('defaults --sprint to the pinned current sprint (with a stderr notice)', async () => {
      const sprint = makeDraftSprint();
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      await repo.saveAll(sprint.id, [makeTodoTask({ name: 'pinned task', order: 1 })]);
      await createLastSelectionStore(cli.paths.stateRoot).write({
        projectId: sprint.projectId,
        sprintId: sprint.id,
      });

      const result = await runCliCaptured(cli, ['task', 'list']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('pinned task');
      // The fallback path must announce the substituted sprint so a stale pin never
      // silently targets the wrong one.
      expect(result.stderr).toContain(`using current sprint ${String(sprint.id)}`);
    });

    it('exits 1 with guidance when --sprint is omitted and nothing is pinned', async () => {
      const result = await runCliCaptured(cli, ['task', 'list']);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no sprint specified');
      expect(result.stderr).toContain('--sprint');
      expect(result.stderr).toContain('sprint set-current');
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
      const blocked = markTaskBlocked(makeTodoTask({ name: 'wedged' }), 'flaky verify', 'own');
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

  /**
   * `task evaluation` is the CLI half of the evaluation-artifact surface. Absence is NEVER an
   * error here — a task with no attempts, a legacy row with no recorded path, and a pruned
   * workspace all print one line and exit 0. Only a mistyped id exits 1.
   */
  describe('evaluation <taskId>', () => {
    const taskWithEvaluation = (file: string, name = 'evaluated'): Task => {
      const started = startNextAttempt(makeTodoTask({ name }), ATTEMPT_STARTED_AT, 'session-1');
      if (!started.ok) throw new Error(`fixture: ${started.error.message}`);
      const evaluated = recordRunningAttemptEvaluation(started.value, { status: 'failed', file });
      if (!evaluated.ok) throw new Error(`fixture: ${evaluated.error.message}`);
      return evaluated.value;
    };

    const seed = async (task: Task, sprintId: string): Promise<void> => {
      const repo = createFsTaskRepository({ root: cli.paths.dataRoot });
      await repo.saveAll(sprintId as never, [task]);
    };

    const writeArtifact = async (sprintId: string, taskId: string, relative: string, body: string): Promise<void> => {
      const dir = join(String(cli.paths.dataRoot), 'sprints', sprintId, 'implement', taskId, dirname(relative));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(join(dir, basename(relative)), body, 'utf8');
    };

    it('prints the artifact body verbatim on stdout with a provenance header on stderr', async () => {
      const sprint = makeDraftSprint();
      const relative = 'rounds/2/evaluator/evaluation.md';
      const task = taskWithEvaluation(relative);
      await seed(task, String(sprint.id));
      await writeArtifact(
        String(sprint.id),
        String(task.id),
        relative,
        '# Evaluation — failed\n\n## Critique\n\nthe legacy row is untested\n'
      );

      const result = await runCliCaptured(cli, ['task', 'evaluation', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('# Evaluation — failed');
      expect(result.stdout).toContain('the legacy row is untested');
      // Provenance on stderr so `> verdict.md` yields exactly the artifact.
      expect(result.stderr).toContain('attempt 1');
      expect(result.stderr).toContain('eval failed');
      expect(result.stderr).toContain(relative);
    });

    it('reports "none recorded" and exits 0 for a task that never reached the evaluator', async () => {
      const sprint = makeDraftSprint();
      const task = makeTodoTask({ name: 'never ran' });
      await seed(task, String(sprint.id));

      const result = await runCliCaptured(cli, ['task', 'evaluation', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no evaluation recorded for task');
    });

    it('degrades to a one-liner (exit 0) for a legacy row whose evaluation has no artifact path', async () => {
      const sprint = makeDraftSprint();
      const task = taskWithEvaluation('', 'legacy');
      await seed(task, String(sprint.id));

      const result = await runCliCaptured(cli, ['task', 'evaluation', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no evaluation artifact recorded for attempt 1');
      expect(result.stdout).toContain('legacy record');
    });

    it('degrades to a one-liner (exit 0) when the workspace was pruned', async () => {
      const sprint = makeDraftSprint();
      const relative = 'rounds/1/evaluator/evaluation.md';
      const task = taskWithEvaluation(relative);
      await seed(task, String(sprint.id));
      // Artifact deliberately never written — the sprint dir exists (tasks.json lives there).

      const result = await runCliCaptured(cli, ['task', 'evaluation', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('evaluation artifact not found on disk');
      expect(result.stdout).toContain(relative);
    });

    it('refuses a recorded path that climbs out of the workspace, degrading rather than reading it', async () => {
      const sprint = makeDraftSprint();
      const task = taskWithEvaluation('../../../../../../etc/passwd', 'hostile');
      await seed(task, String(sprint.id));

      const result = await runCliCaptured(cli, ['task', 'evaluation', String(task.id), '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no evaluation artifact recorded');
      expect(result.stdout).not.toContain('root:');
    });

    it('exits 1 on malformed task id', async () => {
      const sprint = makeDraftSprint();
      const result = await runCliCaptured(cli, ['task', 'evaluation', 'nope', '--sprint', String(sprint.id)]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('invalid task id');
    });
  });
});
