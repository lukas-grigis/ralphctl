import { describe, expect, it } from 'vitest';

import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { EditTaskUseCase } from './edit-task.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function makeSprintId(): SprintId {
  const slug = Slug.parse('demo');
  if (!slug.ok) throw new Error('precondition failed');
  return SprintId.create(new Date('2026-04-29T00:00:00.000Z'), slug.value);
}

function makeTask(name: string): Task {
  const r = Task.create({
    name,
    steps: [],
    verificationCriteria: [],
    order: 1,
    projectPath: path('/abs/repo'),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('EditTaskUseCase', () => {
  it('updates the name and persists', async () => {
    const sprintId = makeSprintId();
    const t = makeTask('original');
    const repo = new InMemoryTaskRepository([[sprintId, [t]]]);
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({ sprintId, taskId: t.id, name: 'updated' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('updated');

    const reread = await repo.findById(sprintId, t.id);
    if (!reread.ok) throw new Error('expected task');
    expect(reread.value.name).toBe('updated');
  });

  it('updates multiple fields at once', async () => {
    const sprintId = makeSprintId();
    const t = makeTask('original');
    const repo = new InMemoryTaskRepository([[sprintId, [t]]]);
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({
      sprintId,
      taskId: t.id,
      name: 'new name',
      description: 'desc',
      steps: ['s1'],
      verificationCriteria: ['vc1'],
      projectPath: path('/abs/other'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('new name');
    expect(result.value.description).toBe('desc');
    expect(result.value.steps).toStrictEqual(['s1']);
    expect(result.value.verificationCriteria).toStrictEqual(['vc1']);
    expect(result.value.projectPath).toBe(path('/abs/other'));
  });

  it('clears description when null is passed', async () => {
    const sprintId = makeSprintId();
    const r = Task.create({
      name: 'x',
      description: 'old',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: path('/abs/r'),
    });
    if (!r.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sprintId, [r.value]]]);
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({ sprintId, taskId: r.value.id, description: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBeUndefined();
  });

  it('returns NotFoundError when the task is missing', async () => {
    const sprintId = makeSprintId();
    const repo = new InMemoryTaskRepository();
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({
      sprintId,
      taskId: TaskId.trustString('ffffffff'),
      name: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns InvalidStateError when the task is in_progress', async () => {
    const sprintId = makeSprintId();
    const t = makeTask('x');
    const ip = t.markInProgress();
    if (!ip.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sprintId, [ip.value]]]);
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({ sprintId, taskId: t.id, name: 'too late' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });

  it('returns ValidationError on empty name', async () => {
    const sprintId = makeSprintId();
    const t = makeTask('x');
    const repo = new InMemoryTaskRepository([[sprintId, [t]]]);
    const uc = new EditTaskUseCase(repo);

    const result = await uc.execute({ sprintId, taskId: t.id, name: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });
});
