/**
 * `saveTasksLeaf` tests.
 *
 * The leaf now writes two artefacts per execution:
 *   1. `tasks.json` via `TaskRepository.saveAll`
 *   2. `<sprintDir>/done-criteria.md` — one bullet per task
 *
 * `done-criteria.md` is written to `<RALPHCTL_ROOT>/data/sprints/<id>/done-criteria.md`.
 * We point `RALPHCTL_ROOT` at a tmp directory before each test so the
 * path assertions are predictable and no state leaks between runs.
 */
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { makeSprint, makeTask } from '@src/application/_test-fakes/fixtures.ts';
import { resolveStoragePaths, resetEnsureLayoutDirsCache } from '@src/integration/persistence/storage-paths.ts';
import { saveTasksLeaf, renderDoneCriteria, type SaveTasksCtx } from './save-tasks.ts';

const TEST_ROOT = '/tmp/ralphctl-save-tasks-test';

beforeEach(() => {
  process.env['RALPHCTL_ROOT'] = TEST_ROOT;
  resetEnsureLayoutDirsCache();
});
afterEach(() => {
  delete process.env['RALPHCTL_ROOT'];
  resetEnsureLayoutDirsCache();
});

describe('saveTasksLeaf', () => {
  it('replaces the task list for a sprint via saveAll', async () => {
    const sprint = makeSprint();
    const repo = new InMemoryTaskRepository();
    const leaf = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });
    const tasks = [makeTask({ name: 'one' })];

    const result = await leaf.execute({ sprintId: sprint.id, tasks });
    expect(result.ok).toBe(true);

    const reread = await repo.findBySprintId(sprint.id);
    if (!reread.ok) throw new Error('expected tasks');
    expect(reread.value.map((t) => t.name)).toStrictEqual(['one']);
  });

  it('also writes done-criteria.md alongside tasks.json', async () => {
    const sprint = makeSprint({ name: 'Criteria Sprint', slug: 'crit' });
    const repo = new InMemoryTaskRepository();
    const leaf = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });
    const task = makeTask({ name: 'Wire login' });

    const result = await leaf.execute({ sprintId: sprint.id, tasks: [task] });
    expect(result.ok).toBe(true);

    const storage = resolveStoragePaths();
    const criteriaPath = String(storage.doneCriteriaFile(sprint.id));
    const body = await readFile(criteriaPath, 'utf-8');

    // File must contain the task name and id.
    expect(body).toContain('Wire login');
    expect(body).toContain(String(task.id));
    // Verification criteria are included.
    expect(body).toContain('it works');
    // Heading present.
    expect(body).toContain('# Done criteria');
  });

  it('emits the fallback sentinel when a task has no verificationCriteria', () => {
    // renderDoneCriteria is the pure renderer — test it directly.
    // Task.create always populates verificationCriteria, so we use the
    // renderDoneCriteria tests below to exercise the empty-criteria branch.
    const rendered = renderDoneCriteria([]);
    // Empty task list — only the header section.
    expect(rendered).toContain('# Done criteria');
  });

  it('fails the step when ctx.tasks is missing', async () => {
    const sprint = makeSprint();
    const repo = new InMemoryTaskRepository();
    const leaf = saveTasksLeaf<SaveTasksCtx>({ taskRepo: repo });

    const result = await leaf.execute({ sprintId: sprint.id });
    expect(result.ok).toBe(false);
  });
});

describe('renderDoneCriteria', () => {
  it('produces one bullet per task with name, id, and joined criteria', () => {
    const task = makeTask({ name: 'Add login' });
    const rendered = renderDoneCriteria([task]);

    expect(rendered).toContain('# Done criteria');
    expect(rendered).toContain('Add login');
    expect(rendered).toContain(String(task.id));
    // The default makeTask criteria is ['it works'].
    expect(rendered).toContain('it works');
    // Trailing newline.
    expect(rendered.endsWith('\n')).toBe(true);
  });

  it('joins multiple criteria with "; "', () => {
    const task = makeTask({ name: 'Multi' });
    // Override verificationCriteria via unknown cast — testing the renderer, not the domain.
    const multiTask = {
      ...(task as unknown as Record<string, unknown>),
      verificationCriteria: ['Criterion A', 'Criterion B'],
    } as unknown as typeof task;
    const rendered = renderDoneCriteria([multiTask]);

    expect(rendered).toContain('Criterion A; Criterion B');
  });

  it('emits fallback sentinel for tasks with empty criteria', () => {
    const task = makeTask({ name: 'No criteria' });
    // Spread the task and override verificationCriteria via unknown cast
    // (pure renderer test — Task.create always fills this field, so we
    // bypass the domain constructor to exercise the empty branch).
    const empty = {
      ...(task as unknown as Record<string, unknown>),
      verificationCriteria: [],
    } as unknown as typeof task;
    const rendered = renderDoneCriteria([empty]);

    expect(rendered).toContain('(no explicit criteria — use task description as proxy)');
  });
});
