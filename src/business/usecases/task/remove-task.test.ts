import { describe, expect, it } from 'vitest';

import { Task } from '../../../domain/entities/task.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import { InMemoryTaskRepository } from '../../_test-fakes/in-memory-task-repository.ts';
import { RemoveTaskUseCase } from './remove-task.ts';

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function task(id: string, order: number): Task {
  const tidR = TaskId.parse(id);
  if (!tidR.ok) throw new Error('precondition failed');
  const r = Task.create({
    id: tidR.value,
    name: id,
    steps: [],
    verificationCriteria: [],
    order,
    projectPath: path('/abs/r'),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('RemoveTaskUseCase', () => {
  it('removes the matching task and returns the updated list', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository([[sid, [task('aaaaaaaa', 1), task('bbbbbbbb', 2)]]]);
    const uc = new RemoveTaskUseCase(repo);

    const tid = TaskId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');

    const result = await uc.execute({ sprintId: sid, taskId: tid.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((t) => t.id)).toEqual(['bbbbbbbb']);
  });

  it('returns NotFoundError when the task id is missing', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository([[sid, [task('aaaaaaaa', 1)]]]);
    const uc = new RemoveTaskUseCase(repo);

    const missing = TaskId.parse('cccccccc');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({ sprintId: sid, taskId: missing.value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('returns NotFoundError when the sprint has no tasks at all', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository();
    const uc = new RemoveTaskUseCase(repo);

    const tid = TaskId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');

    const result = await uc.execute({ sprintId: sid, taskId: tid.value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
