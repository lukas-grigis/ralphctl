import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { settleAttemptUseCase } from '@src/business/task/settle-attempt.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { recordRunningAttemptVerification } from '@src/domain/entity/task-attempts.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { FIXED_LATER, makeInProgressTaskWithRunningAttempt } from '@tests/fixtures/domain.ts';

const SPRINT_ID = 'sprint-x' as SprintId;

const fakeUpdateTask = (
  result: Result<void, NotFoundError | StorageError> = Result.ok(undefined)
): { readonly repo: UpdateTask; readonly calls: Task[] } => {
  const calls: Task[] = [];
  const repo: UpdateTask = {
    async update(_sprintId, task) {
      calls.push(task);
      return result;
    },
  };
  return { repo, calls };
};

describe('settleAttemptUseCase — task-blocked notification', () => {
  it('publishes a task-blocked event when a self-block persists, with only the first line of the reason', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask();
    const bus = createInMemoryEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'generator emitted <task-blocked>\nstash: ralphctl/sprint-x/task-1/blocked-diff',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      eventBus: bus,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');

    const blocked = seen.filter((e) => e.type === 'task-blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({
      type: 'task-blocked',
      taskId: String(ip.id),
      taskName: ip.name,
      blockKind: 'own',
      reason: 'generator emitted <task-blocked>',
      at: FIXED_LATER,
    });
  });

  it('publishes a task-blocked event when the attempt budget is exhausted (no explicit blockedReason)', async () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { repo } = fakeUpdateTask();
    const bus = createInMemoryEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      shouldFailAttempt: true,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      eventBus: bus,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('blocked');

    const blocked = seen.filter((e) => e.type === 'task-blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      type: 'task-blocked',
      taskId: String(ip.id),
      blockKind: 'own',
      reason: 'attempt budget exhausted (maxAttempts=1)',
    });
  });

  it('does not publish task-blocked when the task settles done', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const verified = recordRunningAttemptVerification(ip);
    if (!verified.ok) throw new Error('fixture: recordRunningAttemptVerification failed');
    const { repo } = fakeUpdateTask();
    const bus = createInMemoryEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await settleAttemptUseCase({
      task: verified.value,
      sprintId: SPRINT_ID,
      verdict: 'passed',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      eventBus: bus,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('done');
    expect(seen.filter((e) => e.type === 'task-blocked')).toHaveLength(0);
  });

  it('does not publish task-blocked when a retry is granted and the task stays in_progress', async () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const { repo } = fakeUpdateTask();
    const bus = createInMemoryEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      shouldFailAttempt: true,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      eventBus: bus,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('in_progress');
    expect(seen.filter((e) => e.type === 'task-blocked')).toHaveLength(0);
  });

  it('does not publish task-blocked when persisting the blocked task fails', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask(Result.error(new StorageError({ subCode: 'io', message: 'disk full' })));
    const bus = createInMemoryEventBus();
    const seen: AppEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'generator emitted <task-blocked>',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
      eventBus: bus,
    });

    expect(result.ok).toBe(false);
    expect(seen.filter((e) => e.type === 'task-blocked')).toHaveLength(0);
  });

  it('never throws and settles normally when no eventBus is wired', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo, calls } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'generator emitted <task-blocked>',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe('blocked');
  });
});

describe('settleAttemptUseCase — blockCause / faultSide classification', () => {
  it('classifies a vague self-block as generator-self-block/model, never the generic unknown fallback', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'the generator gave a vague reason with no recognizable prefix',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('generator-self-block');
    expect(result.value.faultSide).toBe('model');
  });

  it('classifies a real post-verify-regression reason correctly from its text', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'verify script regressed baseline (exit=1); harness will not commit on red',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('post-verify-regression');
    expect(result.value.faultSide).toBe('model');
  });

  it('a crash-attributed self-block overrides the text-based fault side to harness/environment', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'AI process repeatedly crashed; attempt budget exhausted',
      abortCause: 'process-crash',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('budget-exhausted');
    expect(result.value.faultSide).toBe('environment');
  });

  it('classifies attempt-budget-cap exhaustion (shouldFailAttempt path) as budget-exhausted/model with no crash', async () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      shouldFailAttempt: true,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('budget-exhausted');
    expect(result.value.faultSide).toBe('model');
  });

  it('a watchdog-killed abort cause reaching the attempt cap classifies the exhaustion as harness, not model', async () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      shouldFailAttempt: true,
      abortCause: 'watchdog-killed',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('budget-exhausted');
    expect(result.value.faultSide).toBe('harness');
  });

  it('a repeatedly-malformed evaluator exhausting the budget classifies as a grader fault, not model', async () => {
    const ip = makeInProgressTaskWithRunningAttempt({ maxAttempts: 1 });
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'malformed',
      shouldFailAttempt: true,
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockCause).toBe('budget-exhausted');
    expect(result.value.faultSide).toBe('grader');
  });
});

describe('settleAttemptUseCase — generator blocker triage persistence', () => {
  // Regression: the generator's structured `task-blocked` triage (blockerClass / question /
  // whatUnblocksMe) used to be validated by the signal schema and then discarded — nothing
  // downstream of `run-generator-turn.ts` ever read past `.reason`. These fields must now land
  // on the persisted `BlockedTask` exactly as supplied.
  it('persists blockerClass / question / whatUnblocksMe onto the blocked task when the caller supplies them', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo, calls } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'Scope unclear.',
      blockerClass: 'ambiguous-request',
      question: 'Should this cover the admin routes too?',
      whatUnblocksMe: 'A decision on admin-route scope',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value.blockerClass).toBe('ambiguous-request');
    expect(result.value.question).toBe('Should this cover the admin routes too?');
    expect(result.value.whatUnblocksMe).toBe('A decision on admin-route scope');
    // And the persisted row (what actually lands in tasks.json) carries them too.
    expect(calls[0]).toMatchObject({
      blockerClass: 'ambiguous-request',
      question: 'Should this cover the admin routes too?',
      whatUnblocksMe: 'A decision on admin-route scope',
    });
  });

  it('omits all three fields when the caller supplies none (legacy / minimal self-block)', async () => {
    const ip = makeInProgressTaskWithRunningAttempt();
    const { repo } = fakeUpdateTask();

    const result = await settleAttemptUseCase({
      task: ip,
      sprintId: SPRINT_ID,
      verdict: 'failed',
      blockedReason: 'generator emitted <task-blocked>',
      taskRepo: repo,
      clock: () => FIXED_LATER,
      logger: noopLogger,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.status !== 'blocked') throw new Error('expected a blocked task');
    expect(result.value).not.toHaveProperty('blockerClass');
    expect(result.value).not.toHaveProperty('question');
    expect(result.value).not.toHaveProperty('whatUnblocksMe');
  });
});
