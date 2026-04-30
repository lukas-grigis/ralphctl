import { describe, expect, it } from 'vitest';

import { Task } from '../../../domain/entities/task.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { InMemoryTaskRepository } from '../../_test-fakes/in-memory-task-repository.ts';
import { ListTasksUseCase } from './list-tasks.ts';

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

function task(name: string, order: number): Task {
  const r = Task.create({
    name,
    steps: [],
    verificationCriteria: [],
    order,
    projectPath: path('/abs/r'),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('ListTasksUseCase', () => {
  it('returns an empty array for a sprint with no tasks', async () => {
    const repo = new InMemoryTaskRepository();
    const uc = new ListTasksUseCase(repo);
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));

    const result = await uc.execute({ sprintId: sid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns the seeded task list', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository([[sid, [task('A', 1), task('B', 2)]]]);
    const uc = new ListTasksUseCase(repo);

    const result = await uc.execute({ sprintId: sid });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.map((t) => t.name)).toEqual(['A', 'B']);
  });
});
