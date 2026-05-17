import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { TaskId } from '@src/domain/value/id/task-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { tasksFile } from '@src/integration/persistence/storage.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('createFsTaskRepository', () => {
  let root: AbsolutePath;
  let cleanup: () => Promise<void>;
  const sprintId = SprintId.generate();

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = tmp.root;
    cleanup = tmp.cleanup;
  });

  afterEach(async () => cleanup());

  it('saveAll → findBySprintId round-trips the task set in canonical order', async () => {
    const repo = createFsTaskRepository({ root });
    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });

    const saved = await repo.saveAll(sprintId, [t2, t1]);
    expect(saved.ok).toBe(true);

    const all = await repo.findBySprintId(sprintId);
    if (!all.ok) throw new Error('findBySprintId failed');
    expect(all.value.map((t) => t.name)).toEqual(['t1', 't2']);
  });

  it('findBySprintId returns an empty array when the tasks file does not exist yet', async () => {
    const repo = createFsTaskRepository({ root });
    const all = await repo.findBySprintId(sprintId);
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value).toEqual([]);
    }
  });

  it('findById returns the matching task', async () => {
    const repo = createFsTaskRepository({ root });
    const task = makeTodoTask();
    await repo.saveAll(sprintId, [task]);

    const loaded = await repo.findById(sprintId, task.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.id).toBe(task.id);
  });

  it('findById returns NotFoundError when the task is missing', async () => {
    const repo = createFsTaskRepository({ root });
    await repo.saveAll(sprintId, [makeTodoTask()]);

    const loaded = await repo.findById(sprintId, TaskId.generate());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toBeInstanceOf(NotFoundError);
  });

  it('update replaces a single task in place', async () => {
    const repo = createFsTaskRepository({ root });
    const t1 = makeTodoTask({ name: 't1', order: 1 });
    const t2 = makeTodoTask({ name: 't2', order: 2 });
    await repo.saveAll(sprintId, [t1, t2]);

    const updated = { ...t1, name: 't1-renamed' };
    const result = await repo.update(sprintId, updated);
    expect(result.ok).toBe(true);

    const reloaded = await repo.findById(sprintId, t1.id);
    if (!reloaded.ok) throw new Error('expected ok');
    expect(reloaded.value.name).toBe('t1-renamed');
  });

  it('update returns NotFoundError when the task is unknown', async () => {
    const repo = createFsTaskRepository({ root });
    await repo.saveAll(sprintId, [makeTodoTask()]);

    const stranger = makeTodoTask({ name: 'stranger', order: 99 });
    const result = await repo.update(sprintId, stranger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(NotFoundError);
  });

  it('saveAll overwrites the entire task set', async () => {
    const repo = createFsTaskRepository({ root });
    await repo.saveAll(sprintId, [makeTodoTask({ name: 'old' })]);
    const fresh = makeTodoTask({ name: 'new' });
    await repo.saveAll(sprintId, [fresh]);

    const page = await repo.findBySprintId(sprintId);
    if (!page.ok) throw new Error('expected ok');
    expect(page.value).toHaveLength(1);
    expect(page.value[0]?.name).toBe('new');
  });

  it('surfaces a non-array tasks file as StorageError(parse)', async () => {
    const repo = createFsTaskRepository({ root });
    const path = tasksFile(root, sprintId);
    await fs.mkdir(path.replace(/tasks\.json$/, ''), { recursive: true });
    await fs.writeFile(path, '{ "not": "an array" }');

    const result = await repo.findBySprintId(sprintId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(StorageError);
      expect(result.error.subCode).toBe('parse');
    }
  });
});
