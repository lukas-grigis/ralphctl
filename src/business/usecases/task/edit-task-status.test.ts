import { describe, expect, it } from 'vitest';

import { Task } from '../../../domain/entities/task.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';
import { TaskId } from '../../../domain/values/task-id.ts';
import { InMemoryTaskRepository } from '../../_test-fakes/in-memory-task-repository.ts';
import { EditTaskStatusUseCase } from './edit-task-status.ts';

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

function freshTodoTask(): { sprintId: SprintId; taskId: TaskId; task: Task } {
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
  return { sprintId: sid, taskId: tidR.value, task: taskR.value };
}

describe('EditTaskStatusUseCase', () => {
  it('moves todo → in_progress', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const repo = new InMemoryTaskRepository([[sid, [task]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({ sprintId: sid, taskId, action: { kind: 'mark-in-progress' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('in_progress');
  });

  it('moves in_progress → done after a prior transition', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const inProgressR = task.markInProgress();
    if (!inProgressR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [inProgressR.value]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({ sprintId: sid, taskId, action: { kind: 'mark-done' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('done');
  });

  it('returns InvalidStateError when marking a todo task as done', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const repo = new InMemoryTaskRepository([[sid, [task]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({ sprintId: sid, taskId, action: { kind: 'mark-done' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-state');
  });

  it('returns NotFoundError when the task id is unknown', async () => {
    const sid = SprintId.create(new Date('2026-04-29T14:15:22Z'), slug('a'));
    const repo = new InMemoryTaskRepository();
    const uc = new EditTaskStatusUseCase(repo);

    const missing = TaskId.parse('bbbbbbbb');
    if (!missing.ok) throw new Error('precondition failed');

    const result = await uc.execute({
      sprintId: sid,
      taskId: missing.value,
      action: { kind: 'mark-in-progress' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-found');
  });

  it('marks a todo task blocked with a reason', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const repo = new InMemoryTaskRepository([[sid, [task]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({
      sprintId: sid,
      taskId,
      action: { kind: 'mark-blocked', reason: 'wrong branch' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    expect(result.value.blockedReason).toBe('wrong branch');
  });

  it('marks an in_progress task blocked with a reason', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const inProgressR = task.markInProgress();
    if (!inProgressR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [inProgressR.value]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({
      sprintId: sid,
      taskId,
      action: { kind: 'mark-blocked', reason: 'API down' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');
    expect(result.value.blockedReason).toBe('API down');
  });

  it('unblocks a blocked task back to todo, clearing the reason', async () => {
    const { sprintId: sid, taskId, task } = freshTodoTask();
    const blockedR = task.markBlocked('temp');
    if (!blockedR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [blockedR.value]]]);
    const uc = new EditTaskStatusUseCase(repo);

    const result = await uc.execute({ sprintId: sid, taskId, action: { kind: 'unblock' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('todo');
    expect(result.value.blockedReason).toBeUndefined();
  });
});
