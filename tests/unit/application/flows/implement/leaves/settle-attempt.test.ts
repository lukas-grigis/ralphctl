import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
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

  it('folds ctx.lastEvaluation.criteria onto the persisted task`s criteriaVerdicts', async () => {
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
      lastEvaluation: {
        type: 'evaluation',
        status: 'passed',
        dimensions: [
          { dimension: 'correctness', passed: true, finding: 'ok' },
          { dimension: 'completeness', passed: true, finding: 'ok' },
          { dimension: 'safety', passed: true, finding: 'ok' },
          { dimension: 'consistency', passed: true, finding: 'ok' },
        ],
        criteria: [{ id: 'C1', passed: true, evidence: 'src/foo.ts:1' }],
        timestamp: FIXED_LATER,
      },
    };
    const result = await leafEl.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls[0]?.task.status).toBe('done');
    // The harness-owned per-criterion verdict was folded from the structured signal, not prose.
    expect(calls[0]?.task.criteriaVerdicts).toEqual({ C1: 'passed' });
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

describe('settleAttemptLeaf — outcome.md session-id threading', () => {
  it('threads ctx.priorGeneratorSessionId / priorEvaluatorSessionId into rounds/<N>/outcome.md', async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'ralphctl-settle-outcome-')));
    try {
      const ip = inProgressWithVerification();
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
        lastVerdict: 'passed',
        taskWorkspaceRoot: absolutePath(ws),
        currentRoundNum: 2,
        priorGeneratorSessionId: 'gen-session-123' as ImplementCtx['priorGeneratorSessionId'],
        priorEvaluatorSessionId: 'eval-session-456' as ImplementCtx['priorEvaluatorSessionId'],
      };
      const result = await leafEl.execute(ctx);
      expect(result.ok).toBe(true);

      const outcome = await readFile(join(ws, 'rounds', '2', 'outcome.md'), 'utf8');
      // The ctx per-round generator id wins over the attempt-level fallback; the evaluator id has no
      // fallback and was previously always '—'.
      expect(outcome).toContain('- generator session: gen-session-123');
      expect(outcome).toContain('- evaluator session: eval-session-456');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('settleAttemptLeaf — outcome.md retry-text gating on shouldFailAttempt', () => {
  const failedCtx = (ws: string, ip: InProgressTask, shouldFailAttempt: boolean): ImplementCtx => ({
    sprintId: 'sprint-x' as SprintId,
    tasks: [ip],
    currentTaskId: ip.id,
    currentTask: ip,
    lastVerdict: 'failed',
    ...(shouldFailAttempt ? { lastShouldFailAttempt: true } : {}),
    lastEvaluation: {
      type: 'evaluation',
      status: 'failed',
      dimensions: [
        { dimension: 'correctness', passed: true, finding: 'ok' },
        { dimension: 'completeness', passed: false, finding: 'missing edge case' },
      ],
      timestamp: FIXED_LATER,
    },
    taskWorkspaceRoot: absolutePath(ws),
    currentRoundNum: 1,
  });

  it('a granted retry (lastShouldFailAttempt) promises round N+1 in outcome.md', async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'ralphctl-settle-retrytext-')));
    try {
      const ip = inProgressWithVerification(3);
      const { repo } = fakeUpdateTask();
      const leafEl = settleAttemptLeaf(
        { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
        { cwd: absolutePath('/tmp/settle-attempt-test') },
        ip.id
      );
      const result = await leafEl.execute(failedCtx(ws, ip, true));
      expect(result.ok).toBe(true);

      const outcome = await readFile(join(ws, 'rounds', '1', 'outcome.md'), 'utf8');
      expect(outcome).toContain('round 2 will retry.');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('a terminal round (no lastShouldFailAttempt) does not promise a next round in outcome.md', async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'ralphctl-settle-retrytext-')));
    try {
      const ip = inProgressWithVerification(3);
      const { repo } = fakeUpdateTask();
      const leafEl = settleAttemptLeaf(
        { taskRepo: repo, clock: () => FIXED_LATER, logger: noopLogger },
        { cwd: absolutePath('/tmp/settle-attempt-test') },
        ip.id
      );
      const result = await leafEl.execute(failedCtx(ws, ip, false));
      expect(result.ok).toBe(true);

      const outcome = await readFile(join(ws, 'rounds', '1', 'outcome.md'), 'utf8');
      expect(outcome).toContain('the harness will not start another round for this attempt.');
      expect(outcome).not.toContain('will retry');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
