import { describe, expect, it } from 'vitest';

import { Task } from '@src/domain/entities/task.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { SprintId } from '@src/domain/values/sprint-id.ts';
import { TaskId } from '@src/domain/values/task-id.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { AddTaskUseCase } from './add-task.ts';

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

function sprintId(s = 'a'): SprintId {
  return SprintId.create(new Date('2026-04-29T14:15:22Z'), slug(s));
}

describe('AddTaskUseCase', () => {
  it('appends a task to an empty sprint and auto-assigns order=1', async () => {
    const repo = new InMemoryTaskRepository();
    const uc = new AddTaskUseCase(repo);
    const sid = sprintId();

    const result = await uc.execute({
      sprintId: sid,
      taskInput: {
        name: 'A',
        steps: ['s'],
        verificationCriteria: ['v'],
        projectPath: path('/abs/r'),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.order).toBe(1);
  });

  it('auto-assigns next order when tasks already exist', async () => {
    const sid = sprintId();
    const seedR = Task.create({
      name: 'first',
      steps: [],
      verificationCriteria: [],
      order: 7,
      projectPath: path('/abs/r'),
    });
    if (!seedR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [seedR.value]]]);
    const uc = new AddTaskUseCase(repo);

    const result = await uc.execute({
      sprintId: sid,
      taskInput: {
        name: 'second',
        steps: [],
        verificationCriteria: [],
        projectPath: path('/abs/r'),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[1]?.order).toBe(8);
  });

  it('respects explicit order when provided', async () => {
    const repo = new InMemoryTaskRepository();
    const uc = new AddTaskUseCase(repo);

    const result = await uc.execute({
      sprintId: sprintId(),
      taskInput: {
        name: 'A',
        steps: [],
        verificationCriteria: [],
        order: 42,
        projectPath: path('/abs/r'),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.order).toBe(42);
  });

  it('returns ValidationError on bad task input', async () => {
    const repo = new InMemoryTaskRepository();
    const uc = new AddTaskUseCase(repo);

    const result = await uc.execute({
      sprintId: sprintId(),
      taskInput: {
        name: '   ',
        steps: [],
        verificationCriteria: [],
        projectPath: path('/abs/r'),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-value');
  });

  it('returns ConflictError on duplicate task id', async () => {
    const sid = sprintId();
    const tidR = TaskId.parse('aaaaaaaa');
    if (!tidR.ok) throw new Error('precondition failed');
    const seedR = Task.create({
      id: tidR.value,
      name: 'first',
      steps: [],
      verificationCriteria: [],
      order: 1,
      projectPath: path('/abs/r'),
    });
    if (!seedR.ok) throw new Error('precondition failed');
    const repo = new InMemoryTaskRepository([[sid, [seedR.value]]]);
    const uc = new AddTaskUseCase(repo);

    const result = await uc.execute({
      sprintId: sid,
      taskInput: {
        id: tidR.value,
        name: 'second',
        steps: [],
        verificationCriteria: [],
        projectPath: path('/abs/r'),
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('conflict');
  });
});
