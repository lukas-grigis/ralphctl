import { describe, expect, it } from 'vitest';

import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { ShowTaskUseCase } from './show-task.ts';

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

describe('ShowTaskUseCase', () => {
  it('returns a task when found', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const tidR = TaskId.parse('aaaaaaaa');
    if (!tidR.ok) throw new Error('precondition failed');
    const taskR = Task.create({
      id: tidR.value,
      name: 'A',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: path('/abs/r'),
    });
    if (!taskR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [taskR.value]]]);
    const uc = new ShowTaskUseCase(repo);

    const result = await uc.execute({ sprintId: sid, taskId: tidR.value });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('aaaaaaaa');
  });

  it('returns NotFoundError when the task is missing', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository();
    const uc = new ShowTaskUseCase(repo);

    const missing = TaskId.parse('bbbbbbbb');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({ sprintId: sid, taskId: missing.value });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });
});
