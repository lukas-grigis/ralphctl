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

    // The just-settled prior attempt carries the inferred `process-crash` cause — we
    // don't know if it was Ctrl-C, SIGTERM or v8 OOM from a fresh process, but the cause
    // is at minimum populated (no longer 'unknown') so post-mortem tooling has a label.
    const priorAborted = next.attempts.at(-2);
    if (priorAborted?.status === 'aborted') {
      expect(priorAborted.abortCause).toBe('process-crash');
    }

    // The fresh running attempt carries the recovery context pointing at the prior n.
    const fresh = next.attempts.at(-1);
    if (fresh?.status === 'running') {
      expect(fresh.recovering).toBeDefined();
      expect(fresh.recovering?.fromAttemptN).toBe(priorAttemptCount);
      expect(fresh.recovering?.cause).toBe('process-crash');
    }
  });

  it('heals a status-corrupt `todo` task whose last attempt is still `running`', async () => {
    // The wedge state observed in the field: a crash persisted the task as `todo` while its last
    // attempt was left `running` (n=2). The old recovery branch was gated on `status ===
    // 'in_progress'`, so it skipped this task and `startNextAttempt` dead-ended every launch with
    // "already has a running attempt n=2". The fix keys recovery on the running attempt itself.
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const wedged: Task = { ...inProgress, status: 'todo' };
    expect(wedged.status).toBe('todo');
    expect(wedged.attempts.at(-1)?.status).toBe('running');

    const priorAttemptCount = wedged.attempts.length;
    const { repo, writes } = fakeTaskRepo(new Map([[String(wedged.id), wedged]]));

    const result = await startAttemptUseCase({
      task: wedged,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.value;

    // Status repaired to `in_progress`; leftover attempt settled `aborted`; a fresh `running`
    // attempt appended — exactly the in_progress crash-resume outcome.
    expect(next.status).toBe('in_progress');
    expect(next.attempts).toHaveLength(priorAttemptCount + 1);
    expect(next.attempts.at(-1)?.status).toBe('running');
    expect(next.attempts.at(-2)?.status).toBe('aborted');
    expect(next.attempts.at(-1)?.recovering?.fromAttemptN).toBe(priorAttemptCount);
    expect(writes).toHaveLength(1);
  });

  it('persists the blocked transition when settling the leftover attempt exhausts the budget', async () => {
    // The task crashed DURING its final allowed attempt (maxAttempts=1, one running attempt). On
    // resume the leftover attempt settles `aborted`, pushing the task over budget → `blocked`. The
    // use case must PERSIST that blocked state before surfacing the error — otherwise the running
    // attempt stays on disk and every relaunch re-hits the same resume path and re-errors (a stuck
    // loop), while the task never reports as blocked and the operator has nothing to `unblock`.
    const crashed = makeInProgressTaskWithRunningAttempt();
    const atBudget: Task = { ...crashed, maxAttempts: 1 };
    expect(atBudget.attempts).toHaveLength(1);

    const { repo, writes } = fakeTaskRepo(new Map([[String(atBudget.id), atBudget]]));

    const result = await startAttemptUseCase({
      task: atBudget,
      sprintId: SPRINT_ID,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    // Surfaced as an error so the chain does not try to start an attempt on a blocked task…
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/is blocked/);

    // …but the blocked transition is durably persisted (the regression: it was computed yet never
    // written, so the launch queue could never filter it out).
    expect(writes).toHaveLength(1);
    expect(writes[0]?.status).toBe('blocked');
    expect(writes[0]?.attempts.at(-1)?.status).toBe('aborted');
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
