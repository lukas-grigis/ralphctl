import { describe, expect, it } from 'vitest';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import {
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { terminalTaskStatus } from '@src/application/flows/implement/leaves/per-task-subchain.ts';

const blockedFrom = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): Task => {
  const result = markTaskBlocked(task, 'plateau persists after escalation');
  if (!result.ok) throw new Error('fixture: markTaskBlocked failed');
  return result.value;
};

const ctxWith = (tasks: readonly Task[]): ImplementCtx => ({
  sprintId: makePlannedSprint().id,
  tasks,
});

describe('terminalTaskStatus', () => {
  it('returns true for a done task — the attempt loop stops', () => {
    const done = makeDoneTask();
    expect(terminalTaskStatus(ctxWith([done]), done.id)).toBe(true);
  });

  it('returns true for a blocked task — the attempt loop stops', () => {
    const blocked = blockedFrom(makeInProgressTaskWithRunningAttempt());
    expect(terminalTaskStatus(ctxWith([blocked]), blocked.id)).toBe(true);
  });

  it('returns false for an in_progress task — the attempt loop runs another attempt (escalation retry)', () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    expect(terminalTaskStatus(ctxWith([inProgress]), inProgress.id)).toBe(false);
  });

  it('returns false for a todo task — defensively non-terminal', () => {
    const todo = makeTodoTask();
    expect(terminalTaskStatus(ctxWith([todo]), todo.id)).toBe(false);
  });

  it('keys on the requested task id, not the first task in the list', () => {
    const done = makeDoneTask({ name: 'task-done' });
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const ctx = ctxWith([done, inProgress]);
    // The looked-up task drives the verdict — done id is terminal, in_progress id is not.
    expect(terminalTaskStatus(ctx, done.id)).toBe(true);
    expect(terminalTaskStatus(ctx, inProgress.id)).toBe(false);
  });

  it('treats a missing task id as terminal so the loop exits rather than spinning', () => {
    const present = makeInProgressTaskWithRunningAttempt();
    const absent = makeTodoTask({ name: 'never-loaded' });
    expect(terminalTaskStatus(ctxWith([present]), absent.id)).toBe(true);
  });

  it('treats an undefined ctx.tasks as a missing task (terminal)', () => {
    const todo = makeTodoTask();
    const ctx: ImplementCtx = { sprintId: makePlannedSprint().id };
    expect(terminalTaskStatus(ctx, todo.id)).toBe(true);
  });
});
