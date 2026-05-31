import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { FindTaskById } from '@src/domain/repository/task/find-task-by-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import {
  FIXED_LATER,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { startAttemptLeaf } from '@src/application/flows/implement/leaves/start-attempt.ts';

const captureLogEvents = (
  bus: ReturnType<typeof createInMemoryEventBus>
): Array<{ level: string; message: string }> => {
  const captured: Array<{ level: string; message: string }> = [];
  bus.subscribe((e) => {
    if (e.type === 'log') captured.push({ level: e.level, message: e.message });
  });
  return captured;
};

interface RecordedUpdate {
  readonly sprintId: SprintId;
  readonly task: Task;
}

const fakeUpdateTask = (
  opts: { fail?: StorageError; tasksById?: ReadonlyMap<string, Task> } = {}
): {
  repo: UpdateTask & FindTaskById;
  calls: RecordedUpdate[];
} => {
  const calls: RecordedUpdate[] = [];
  const repo: UpdateTask & FindTaskById = {
    async update(sprintId, task) {
      calls.push({ sprintId, task });
      if (opts.fail) return Result.error(opts.fail);
      return Result.ok(undefined);
    },
    async findById(_sprintId: SprintId, taskId: TaskId) {
      const found = opts.tasksById?.get(String(taskId));
      if (found !== undefined) return Result.ok(found);
      return Result.error(new NotFoundError({ entity: 'task', id: String(taskId) }));
    },
  };
  return { repo, calls };
};

describe('startAttemptLeaf', () => {
  it('appends a running attempt, persists, and writes ctx.currentTask', async () => {
    const todo = makeTodoTask();
    const { repo, calls } = fakeUpdateTask();
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const logger = createEventBusLogger({ eventBus, clock: () => FIXED_LATER });
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger }, todo.id);

    const initial: ImplementCtx = { sprintId: 'sprint-x' as SprintId, tasks: [todo] };
    const result = await leafEl.execute(initial);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.currentTask?.status).toBe('in_progress');
    expect(result.value.ctx.currentTask?.id).toBe(todo.id);
    expect(result.value.ctx.currentTask?.attempts).toHaveLength(1);
    expect(result.value.ctx.currentTask?.attempts[0]?.status).toBe('running');
    // Tasks list is updated with the in_progress version.
    expect(result.value.ctx.tasks?.[0]?.status).toBe('in_progress');
    // Persisted via repo.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sprintId).toBe('sprint-x');
    expect(calls[0]?.task.id).toBe(todo.id);
    // Log entry emitted.
    expect(eventLog.some((e) => e.message.includes('started attempt'))).toBe(true);
  });

  it('clears prior generator + evaluator session ids at the per-task boundary (new task → new "devs")', async () => {
    const todo = makeTodoTask();
    const { repo } = fakeUpdateTask();
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, todo.id);

    const initial: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [todo],
      // Pretend the prior task's gen-eval rounds left these populated; the new task must NOT
      // inherit them — cross-task resume would mix two unrelated bodies of work into one
      // conversational thread.
      priorGeneratorSessionId: 'leftover-gen-id' as unknown as ImplementCtx['priorGeneratorSessionId'],
      priorEvaluatorSessionId: 'leftover-eval-id' as unknown as ImplementCtx['priorEvaluatorSessionId'],
    };
    const result = await leafEl.execute(initial);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.priorGeneratorSessionId).toBeUndefined();
    expect(result.value.ctx.priorEvaluatorSessionId).toBeUndefined();
  });

  it('clears a stale proposedCommitMessage on attempt re-entry (next attempt proposes its own)', async () => {
    const todo = makeTodoTask();
    const { repo } = fakeUpdateTask();
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, todo.id);

    const initial: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [todo],
      // The prior attempt left a commit message on ctx; it must NOT carry into the new attempt —
      // a stale commit copy would otherwise describe attempt n-1's work on attempt n's commit.
      proposedCommitMessage:
        'fix: stale message from prior attempt' as unknown as ImplementCtx['proposedCommitMessage'],
    };
    const result = await leafEl.execute(initial);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.proposedCommitMessage).toBeUndefined();
  });

  it('throws an InvalidStateError when ctx.tasks is undefined (chain-construction error)', async () => {
    const todo = makeTodoTask();
    const { repo } = fakeUpdateTask();
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, todo.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.trace[0]?.status).toBe('failed');
      expect(result.error.error.message).toContain('ctx.tasks is undefined');
    }
  });

  it('throws when the target task id is not present in ctx.tasks', async () => {
    const todo = makeTodoTask();
    const otherTodo = makeTodoTask({ name: 'other' });
    const { repo } = fakeUpdateTask();
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, todo.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [otherTodo] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error.message).toContain('not found');
  });

  it('surfaces a domain failure when the task is not in todo/in_progress status', async () => {
    const done = makeDoneTask();
    const { repo, calls } = fakeUpdateTask();
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, done.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [done] });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('resume: settles the leftover running attempt as aborted and opens a fresh one', async () => {
    // Simulates a prior chain that started attempt n=1 then aborted before settling it.
    // The next implement launch must transparently pick up — no manual cleanup expected.
    const inProgressWithRunning = makeInProgressTaskWithRunningAttempt();
    expect(inProgressWithRunning.attempts).toHaveLength(1);
    expect(inProgressWithRunning.attempts[0]?.status).toBe('running');

    // Persisted state matches in-memory — the divergence guard expects identical status +
    // attempt count + last-attempt status.
    const { repo, calls } = fakeUpdateTask({
      tasksById: new Map([[String(inProgressWithRunning.id), inProgressWithRunning]]),
    });
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const logger = createEventBusLogger({ eventBus, clock: () => FIXED_LATER });
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger }, inProgressWithRunning.id);

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [inProgressWithRunning],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One write — the new running attempt is appended ATOMICALLY with the prior attempt
    // settled as `aborted`, no intermediate persistence.
    expect(calls).toHaveLength(1);
    const persisted = calls[0]?.task;
    expect(persisted?.attempts).toHaveLength(2);
    expect(persisted?.attempts[0]?.status).toBe('aborted');
    expect(persisted?.attempts[1]?.status).toBe('running');
    expect(persisted?.status).toBe('in_progress');
    // Log surfaces the resume so operators can see why the prior attempt was settled.
    expect(eventLog.some((e) => e.message.includes('recovering aborted attempt'))).toBe(true);
  });

  it('resume: returns InvalidStateError when settling the prior attempt exhausts the budget', async () => {
    // Task with maxAttempts=1 and one running attempt → settling it pushes the task to
    // `blocked`, which the use case surfaces as an InvalidStateError so the chain halts.
    const inProgressMaxed = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { repo, calls } = fakeUpdateTask({
      tasksById: new Map([[String(inProgressMaxed.id), inProgressMaxed]]),
    });
    const leafEl = startAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      inProgressMaxed.id
    );

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [inProgressMaxed] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.message).toContain('blocked');
    expect(calls).toHaveLength(0); // nothing persisted — chain bails before the write.
  });

  it('resume: refuses to overwrite when in-memory diverges from persisted state', async () => {
    // In-memory says 1 running attempt; the persisted copy already moved on to a 2-attempt
    // task. The divergence guard must surface InvalidStateError instead of silently
    // overwriting whichever state was newer.
    const inMemory = makeInProgressTaskWithRunningAttempt();
    const persisted = makeInProgressTaskWithRunningAttempt(); // same shape; reuse builder...
    // ...but force `persisted` to look like it has a different attempt history. Easiest: pass
    // a different attempt-count expectation by faking the persisted task to have 0 attempts
    // (i.e., it was reset between launches). This shape diverges from in-memory's 1 attempt.
    const persistedDivergent: Task = { ...persisted, id: inMemory.id, attempts: [], status: 'todo' };
    const { repo, calls } = fakeUpdateTask({
      tasksById: new Map([[String(inMemory.id), persistedDivergent]]),
    });
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, inMemory.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [inMemory] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.message).toMatch(/diverges/i);
    expect(calls).toHaveLength(0);
  });

  it('resume: refuses when in-memory and persisted share status+count but differ in last-attempt startedAt', async () => {
    // Race the round-2 audit flagged: a concurrent writer replaced the running attempt with
    // one that looks identical from status + count's perspective, but the startedAt timestamps
    // disagree. The divergence guard must catch this so we don't write over the newer attempt.
    const inMemory = makeInProgressTaskWithRunningAttempt();
    const persistedSameShape: Task = {
      ...inMemory,
      attempts: [
        { ...inMemory.attempts[0]!, startedAt: '2099-01-01T00:00:00.000Z' as never },
      ] as typeof inMemory.attempts,
    };
    const { repo, calls } = fakeUpdateTask({
      tasksById: new Map([[String(inMemory.id), persistedSameShape]]),
    });
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, inMemory.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [inMemory] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.message).toMatch(/diverges/i);
    expect(calls).toHaveLength(0);
  });

  it('propagates a repository write failure', async () => {
    const todo = makeTodoTask();
    const failure = new StorageError({ subCode: 'io', message: 'disk full' });
    const { repo } = fakeUpdateTask({ fail: failure });
    const leafEl = startAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, todo.id);

    const result = await leafEl.execute({ sprintId: 'sprint-x' as SprintId, tasks: [todo] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBe(failure);
  });
});
