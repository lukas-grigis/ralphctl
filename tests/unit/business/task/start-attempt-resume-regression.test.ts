import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { startAttemptUseCase } from '@src/business/task/start-attempt.ts';
import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { FIXED_LATER, makeInProgressTaskWithRunningAttempt, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = 'sprint-x' as SprintId;

const fakeTaskRepo = (tasksById?: ReadonlyMap<string, Task>): { repo: UpdateTask & FindTaskById; writes: Task[] } => {
  const writes: Task[] = [];
  const repo: UpdateTask & FindTaskById = {
    async update(_sprintId, task) {
      writes.push(task);
      return Result.ok(undefined);
    },
    async findById(_sprintId: SprintId, taskId: TaskId) {
      const found = tasksById?.get(String(taskId));
      if (found !== undefined) return Result.ok(found);
      return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
    },
  };
  return { repo, writes };
};

describe('startAttemptUseCase — resume from crashed running attempt', () => {
  it('settles the leftover running attempt as aborted and opens a fresh running attempt', async () => {
    // Reproduces the crash-resume scenario: a prior chain transitioned the task to
    // `in_progress` and opened attempt n=1, then the host crashed before the attempt
    // could settle. The use case must transparently settle that running attempt as
    // `aborted` and append a new running attempt, preserving the prior in audit history.
    const crashed = makeInProgressTaskWithRunningAttempt();
    expect(crashed.status).toBe('in_progress');
    expect(crashed.attempts).toHaveLength(1);
    expect(crashed.attempts.at(-1)?.status).toBe('running');

    const priorAttemptCount = crashed.attempts.length;
    const { repo, writes } = fakeTaskRepo(new Map([[String(crashed.id), crashed]]));

    const result = await startAttemptUseCase({
      task: crashed,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.value;

    expect(next.status).toBe('in_progress');
    expect(next.attempts).toHaveLength(priorAttemptCount + 1);
    expect(next.attempts.at(-1)?.status).toBe('running');
    expect(next.attempts.at(-2)?.status).toBe('aborted');

    // Audit history: every prior attempt (including the just-settled aborted one) is
    // preserved on the returned task — no rewriting of history, no truncation.
    const abortedCount = next.attempts.filter((a) => a.status === 'aborted').length;
    expect(abortedCount).toBe(1);

    // One atomic write captures both the settled prior + the new running attempt.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.attempts).toHaveLength(priorAttemptCount + 1);
  });

  it('baseline: starting from a todo task appends exactly one running attempt and no aborted entries', async () => {
    // Symmetric control: the resume-settlement branch is gated on a prior running attempt.
    // A clean `todo` start must NOT synthesise a phantom aborted attempt — the only output
    // is exactly one fresh running attempt.
    const todo = makeTodoTask();
    expect(todo.status).toBe('todo');
    expect(todo.attempts).toHaveLength(0);

    const { repo, writes } = fakeTaskRepo();

    const result = await startAttemptUseCase({
      task: todo,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.value;

    expect(next.status).toBe('in_progress');
    expect(next.attempts).toHaveLength(1);
    expect(next.attempts[0]?.status).toBe('running');
    expect(next.attempts.some((a) => a.status === 'aborted')).toBe(false);

    expect(writes).toHaveLength(1);
  });
});
