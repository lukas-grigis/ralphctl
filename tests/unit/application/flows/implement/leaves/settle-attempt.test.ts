import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { InProgressTask, Task } from '@src/domain/entity/task.ts';
import { recordRunningAttemptVerification, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { absolutePath, FIXED_LATER, FIXED_NOW, makeTodoTask } from '@tests/fixtures/domain.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { settleAttemptLeaf } from '@src/application/flows/implement/leaves/settle-attempt.ts';

const fakeUpdateTask = (): { repo: UpdateTask; calls: Array<{ sprintId: SprintId; task: Task }> } => {
  const calls: Array<{ sprintId: SprintId; task: Task }> = [];
  const repo: UpdateTask = {
    async update(sprintId, task) {
      calls.push({ sprintId, task });
      return Result.ok(undefined);
    },
  };
  return { repo, calls };
};

const inProgressWithVerification = (maxAttempts?: number): InProgressTask => {
  const todo = makeTodoTask(maxAttempts !== undefined ? { maxAttempts } : {});
  const started = startNextAttempt(todo, FIXED_NOW);
  if (!started.ok) throw new Error('fixture: startNextAttempt failed');
  const recorded = recordRunningAttemptVerification(started.value);
  if (!recorded.ok) throw new Error('fixture: recordRunningAttemptVerification failed');
  return recorded.value;
};

describe('settleAttemptLeaf', () => {
  it('passed verdict → markTaskDone, persisted, ctx.tasks updated', async () => {
    const ip = inProgressWithVerification();
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const ctx: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'passed',
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.[0]?.status).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task.status).toBe('done');
    // Per-task scratch state cleared.
    expect(result.value.ctx.currentTask).toBeUndefined();
    expect(result.value.ctx.lastVerdict).toBeUndefined();
  });

  it('failed verdict with budget-exhausted warning → markTaskDone with warning attached', async () => {
    const ip = inProgressWithVerification(1);
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const ctx: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'failed',
      lastWarning: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.[0]?.status).toBe('done');
    if (calls[0]?.task.status === 'done') {
      const verifiedAttempt = calls[0].task.attempts.at(-1);
      expect(verifiedAttempt?.warning).toEqual({ kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 });
    }
  });

  it('malformed verdict → markTaskDone with malformed warning', async () => {
    const ip = inProgressWithVerification(3);
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'malformed',
      lastWarning: { kind: 'malformed', detail: 'no verdict signal' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.[0]?.status).toBe('done');
    if (calls[0]?.task.status === 'done') {
      const verifiedAttempt = calls[0].task.attempts.at(-1);
      expect(verifiedAttempt?.warning).toEqual({ kind: 'malformed', detail: 'no verdict signal' });
    }
  });

  it('verify-failed in ctx.lastVerifyResult promotes to verify-failed warning on the attempt', async () => {
    const ip = inProgressWithVerification(3);
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'passed',
      lastVerifyResult: { kind: 'verify-failed', exitCode: 1, stderr: 'tests failed' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.[0]?.status).toBe('done');
    if (calls[0]?.task.status === 'done') {
      const verifiedAttempt = calls[0].task.attempts.at(-1);
      expect(verifiedAttempt?.warning).toEqual({
        kind: 'verify-failed',
        exitCode: 1,
        stderr: 'tests failed',
      });
    }
  });

  it('lastBlockReason set → markTaskBlocked with the reason; running attempt aborted', async () => {
    const ip = inProgressWithVerification();
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'failed',
      lastBlockReason: 'missing API key',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settled = calls[0]?.task;
    expect(settled?.status).toBe('blocked');
    if (settled?.status === 'blocked') {
      expect(settled.blockedReason).toBe('missing API key');
      // The running attempt has been settled as 'aborted' (so the structural invariant holds).
      const last = settled.attempts[settled.attempts.length - 1];
      expect(last?.status).toBe('aborted');
    }
  });

  it('priorPostVerifyOutcome survives the settle projection (carries to the next task)', async () => {
    const ip = inProgressWithVerification();
    const { repo } = fakeUpdateTask();
    const cwd = absolutePath('/tmp/settle-attempt-test');
    const leafEl = settleAttemptLeaf({ taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger }, { cwd }, ip.id);

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'passed',
      // The previous post-task-verify stamped this on ctx; settle-attempt must NOT clear it.
      priorPostVerifyOutcome: { cwd, outcome: 'success' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Per-attempt fields ARE cleared (sanity).
    expect(result.value.ctx.lastVerdict).toBeUndefined();
    expect(result.value.ctx.lastPreVerifyOutcome).toBeUndefined();
    // But the cross-task carry survives.
    expect(result.value.ctx.priorPostVerifyOutcome).toEqual({ cwd, outcome: 'success' });
  });

  it('throws when neither verdict nor block reason is on ctx', async () => {
    const ip = inProgressWithVerification();
    const { repo } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.message).toContain('no verdict or block reason');
    }
  });
});

describe('settleAttemptLeaf — retry-wins precedence (composed red-verify case)', () => {
  it('shouldFailAttempt + blockedReason together → attempt fails, task stays in_progress (retry outranks the red-verify block)', async () => {
    // finalize granted a retry; a LATER red post-verify stamped lastBlockReason. The remedy
    // ladder's whole point is remedies-before-surrender, so the retry must survive.
    const ip = inProgressWithVerification(3);
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const ctx: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'failed',
      lastBlockReason: 'verify failed after task: regressed (exit 1)',
      lastShouldFailAttempt: true,
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settled = result.value.ctx.tasks?.[0];
    // NOT blocked — the granted retry wins while budget remains.
    expect(settled?.status).toBe('in_progress');
    expect(settled?.attempts.at(-1)?.status).toBe('failed');
    expect(calls[0]?.task.status).toBe('in_progress');
  });

  it('T6: red-post-verify retry (both flags) + budget remaining → task settles in_progress, attempt records failed (not blocked)', async () => {
    // Pins the exact composition T6's post-task-verify leaf produces on a `'regressed'` attribution
    // with budget remaining: `lastShouldFailAttempt: true` AND a regressed `lastBlockReason`. The
    // settle precedence (retry outranks block) must keep the task in_progress for the next attempt
    // and record the running attempt as `failed` — NOT blocked, NOT done. This is the load-bearing
    // guarantee that the red-post-verify retry no longer needs an operator while budget remains.
    const ip = inProgressWithVerification(3); // 1 attempt so far, cap 3 → budget remains
    const { repo, calls } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const result = await leafEl.execute({
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'passed', // the evaluator PASSED — only the harness post-verify regressed
      lastBlockReason: 'verify script regressed baseline (exit=1); harness will not commit on red',
      lastShouldFailAttempt: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settled = result.value.ctx.tasks?.[0];
    expect(settled?.status).toBe('in_progress');
    expect(settled?.attempts.at(-1)?.status).toBe('failed');
    expect(calls[0]?.task.status).toBe('in_progress');
  });

  it('blockedReason WITHOUT a granted retry still blocks (self-block / exhausted paths unchanged)', async () => {
    const ip = inProgressWithVerification(3);
    const { repo } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const ctx: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'failed',
      lastBlockReason: 'agent self-blocked: needs a design decision',
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.tasks?.[0]?.status).toBe('blocked');
  });

  it('malformed verdict on the retry path settles the attempt with status malformed, not failed', async () => {
    const ip = inProgressWithVerification(3);
    const { repo } = fakeUpdateTask();
    const leafEl = settleAttemptLeaf(
      { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
      { cwd: absolutePath('/tmp/settle-attempt-test') },
      ip.id
    );

    const ctx: ImplementCtx = {
      sprintId: 'sprint-x' as SprintId,
      tasks: [ip],
      currentTaskId: ip.id,
      currentTask: ip,
      lastVerdict: 'malformed',
      lastShouldFailAttempt: true,
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const settled = result.value.ctx.tasks?.[0];
    expect(settled?.status).toBe('in_progress');
    // The attempt history reports the REAL failure mode — the evaluator's contract failure.
    expect(settled?.attempts.at(-1)?.status).toBe('malformed');
  });
});
