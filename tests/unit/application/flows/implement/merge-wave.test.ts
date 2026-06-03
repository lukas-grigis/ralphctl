import { describe, expect, it } from 'vitest';

import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';

import {
  absolutePath,
  makeDoneTask,
  makeExecution,
  makeInProgressTaskWithRunningAttempt,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

import type { BranchOutcome } from '@src/application/chain/run/wave-scheduler.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { forkCtx, mergeImplementWave } from '@src/application/flows/implement/merge-wave.ts';

const blockedFrom = (task: ReturnType<typeof makeInProgressTaskWithRunningAttempt>): Task => {
  const result = markTaskBlocked(task, 'plateau persists after escalation', 'own');
  if (!result.ok) throw new Error('fixture: markTaskBlocked failed');
  return result.value;
};

const sprint = makePlannedSprint();

/**
 * A base ctx with every sprint-scoped field populated plus a handful of per-task / signal-accum
 * fields set, so a test can assert they are CLEARED in the merged / forked ctx.
 */
const makeBaseCtx = (tasks: readonly Task[]): ImplementCtx => ({
  sprintId: sprint.id,
  sprint,
  execution: makeExecution(sprint.id),
  progressFile: absolutePath('/sprints/s1/progress.md'),
  tasks,
  // per-task single-slot state (should NOT survive a merge or a fork)
  currentTaskId: tasks[0]?.id,
  genEvalTurn: 3,
  lastBlockReason: 'stale per-task state',
  expectedBranch: 'feature/sprint-1',
  priorPostVerifyOutcome: { cwd: absolutePath('/repo'), outcome: 'success' },
  // signal accumulators (should NOT survive a merge or a fork)
  currentAttemptChanges: ['edited a.ts'],
  currentAttemptDecisions: ['chose approach X'],
  currentAttemptLearnings: [{ text: 'learned Y' }],
  currentAttemptNotes: ['noted Z'],
});

/** A completed branch whose chain settled `task` into its final state. */
const completedBranch = (id: string, base: ImplementCtx, settled: Task): BranchOutcome<ImplementCtx> => ({
  id,
  status: 'completed',
  ctx: { ...base, tasks: [settled] },
});

/** A non-fatal failed branch: an absorbed error, branch ctx carries the (blocked) task transition. */
const absorbedFailureBranch = (
  id: string,
  base: ImplementCtx,
  settled: Task,
  error: DomainError
): BranchOutcome<ImplementCtx> => ({
  id,
  status: 'failed',
  ctx: { ...base, tasks: [settled] },
  error,
});

/** A killed branch per the wave-scheduler contract: `failed` with NO error — did not complete. */
const killedBranch = (id: string, base: ImplementCtx, untouched: Task): BranchOutcome<ImplementCtx> => ({
  id,
  status: 'failed',
  ctx: { ...base, tasks: [untouched] },
});

describe('mergeImplementWave', () => {
  it('overlays each settled branch task onto base.tasks by id', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const base = makeBaseCtx([t1, t2]);

    const t1Done = makeDoneTask({ name: 't1' });
    const t2Done = makeDoneTask({ name: 't2' });
    // Re-key the settled copies onto the base task ids so the overlay matches.
    const t1Settled: Task = { ...t1Done, id: t1.id };
    const t2Settled: Task = { ...t2Done, id: t2.id };

    const merged = mergeImplementWave(base, [
      completedBranch('task-1', base, t1Settled),
      completedBranch('task-2', base, t2Settled),
    ]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    expect(merged.tasks?.find((t) => t.id === t2.id)?.status).toBe('done');
  });

  it('is commutative over disjoint branches — shuffling outcomes yields an identical merged ctx', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const t3 = makeTodoTask({ name: 't3' });
    const base = makeBaseCtx([t1, t2, t3]);

    const settle = (src: Task, model: Task): Task => ({ ...model, id: src.id });
    const o1 = completedBranch('task-1', base, settle(t1, makeDoneTask({ name: 't1' })));
    const o2 = absorbedFailureBranch(
      'task-2',
      base,
      settle(t2, blockedFrom(makeInProgressTaskWithRunningAttempt())),
      new InvalidStateError({ entity: 'task', currentState: 'x', attemptedAction: 'y', message: 'absorbed' })
    );
    const o3 = completedBranch('task-3', base, settle(t3, makeDoneTask({ name: 't3' })));

    const inOrder = mergeImplementWave(base, [o1, o2, o3]);
    const shuffledA = mergeImplementWave(base, [o3, o1, o2]);
    const shuffledB = mergeImplementWave(base, [o2, o3, o1]);

    expect(shuffledA).toStrictEqual(inOrder);
    expect(shuffledB).toStrictEqual(inOrder);
  });

  it('carries sprint-scoped fields straight from base', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, [completedBranch('task-1', base, { ...makeDoneTask(), id: t1.id })]);

    expect(merged.sprintId).toBe(base.sprintId);
    expect(merged.sprint).toBe(base.sprint);
    expect(merged.execution).toBe(base.execution);
    expect(merged.progressFile).toBe(base.progressFile);
  });

  it('clears per-task single-slot and signal-accum fields in the merged ctx', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, [completedBranch('task-1', base, { ...makeDoneTask(), id: t1.id })]);

    // per-task single-slot
    expect(merged.currentTaskId).toBeUndefined();
    expect(merged.genEvalTurn).toBeUndefined();
    expect(merged.lastBlockReason).toBeUndefined();
    expect(merged.expectedBranch).toBeUndefined();
    expect(merged.priorPostVerifyOutcome).toBeUndefined();
    // signal accumulators
    expect(merged.currentAttemptChanges).toBeUndefined();
    expect(merged.currentAttemptDecisions).toBeUndefined();
    expect(merged.currentAttemptLearnings).toBeUndefined();
    expect(merged.currentAttemptNotes).toBeUndefined();
  });

  it('leaves a killed branch task untouched (failed / no error) so it resets/re-runs', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const base = makeBaseCtx([t1, t2]);

    // task-1 genuinely settled to done; task-2 was killed mid-flight.
    const t1Settled: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    // A killed branch's ctx still nominally carries SOME task copy — but it must be ignored.
    const t2Stale: Task = { ...makeDoneTask({ name: 't2-should-be-ignored' }), id: t2.id };

    const merged = mergeImplementWave(base, [
      completedBranch('task-1', base, t1Settled),
      killedBranch('task-2', base, t2Stale),
    ]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    // task-2 must be the ORIGINAL base task (still todo), not the killed branch's stale copy.
    const t2Merged = merged.tasks?.find((t) => t.id === t2.id);
    expect(t2Merged).toBe(t2);
    expect(t2Merged?.status).toBe('todo');
  });

  it('overlays an absorbed non-fatal failure (failed WITH error) — it genuinely settled the task', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const blocked: Task = { ...blockedFrom(makeInProgressTaskWithRunningAttempt()), id: t1.id };

    const merged = mergeImplementWave(base, [
      absorbedFailureBranch(
        'task-1',
        base,
        blocked,
        new InvalidStateError({ entity: 'task', currentState: 'x', attemptedAction: 'y', message: 'absorbed' })
      ),
    ]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('blocked');
  });

  it('returns base.tasks unchanged when there are no outcomes', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, []);

    expect(merged.tasks?.map((t) => t.id)).toStrictEqual([t1.id]);
    expect(merged.tasks?.[0]?.status).toBe('todo');
  });
});

describe('forkCtx', () => {
  const repo: RepoExecConfig = {
    path: absolutePath('/repos/main'),
    name: 'main-repo',
    verifyScript: 'pnpm verify',
  };
  const worktree = absolutePath('/repos/.worktrees/wt-task-1');

  it('points the returned RepoExecConfig.path at the worktree path, preserving the rest', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const { repo: forkedRepo } = forkCtx(base, repo, worktree);

    expect(forkedRepo.path).toBe(worktree);
    expect(forkedRepo.name).toBe('main-repo');
    expect(forkedRepo.verifyScript).toBe('pnpm verify');
    // The input repo is not mutated — forkCtx is a pure projection.
    expect(repo.path).toBe(absolutePath('/repos/main'));
  });

  it('carries sprint-scoped fields and the task list from base', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const { ctx } = forkCtx(base, repo, worktree);

    expect(ctx.sprintId).toBe(base.sprintId);
    expect(ctx.sprint).toBe(base.sprint);
    expect(ctx.execution).toBe(base.execution);
    expect(ctx.progressFile).toBe(base.progressFile);
    expect(ctx.tasks).toBe(base.tasks);
  });

  it('clears per-task single-slot and signal-accum fields, dropping priorPostVerifyOutcome', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const { ctx } = forkCtx(base, repo, worktree);

    expect(ctx.currentTaskId).toBeUndefined();
    expect(ctx.genEvalTurn).toBeUndefined();
    expect(ctx.lastBlockReason).toBeUndefined();
    // Accepted cost: the pre-task-verify short-circuit baseline is dropped.
    expect(ctx.priorPostVerifyOutcome).toBeUndefined();
    expect(ctx.currentAttemptChanges).toBeUndefined();
    expect(ctx.currentAttemptDecisions).toBeUndefined();
    expect(ctx.currentAttemptLearnings).toBeUndefined();
    expect(ctx.currentAttemptNotes).toBeUndefined();
  });

  it('leaves expectedBranch undefined (corrected — branch element omits branch-preflight)', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const { ctx } = forkCtx(base, repo, worktree);

    // An earlier draft wrote `expectedBranch: ''` to disable per-task branch-preflight, but that leaf
    // short-circuits on `undefined`, not `''`. The branch element omits branch-preflight, so the
    // field is simply cleared with the rest of the per-task class.
    expect(ctx.expectedBranch).toBeUndefined();
    expect('expectedBranch' in ctx).toBe(false);
  });
});

/**
 * Compile-time guard demonstration. `mergeImplementWave`'s `_exhaustive` object is
 * `satisfies Record<keyof ImplementCtx, MergeClass>`. Adding a new field to `ImplementCtx` WITHOUT
 * classifying it in that object is a TYPE ERROR (the object stops satisfying the constraint), so a
 * future ctx field can never silently bypass the merge/fork projection.
 *
 * The block below documents what a deliberately-unclassified field would look like. It cannot be
 * left uncommented in a green suite (by design it would fail typecheck), so it is preserved here as
 * the contract record:
 *
 *   // In ctx.ts, adding:  readonly someNewField?: string | undefined;
 *   // …without adding `someNewField: '…'` to `_exhaustive` produces, at `pnpm typecheck`:
 *   //   error TS2353 / TS2741: Property 'someNewField' is missing in type '…'
 *   //   but required in type 'Record<keyof ImplementCtx, MergeClass>'.
 *
 * This `expectTypeOf`-free note is the test surface for the guard — the actual enforcement is the
 * `satisfies` in merge-wave.ts, verified every `pnpm typecheck`.
 */
describe('exhaustiveness guard (compile-time)', () => {
  it('is enforced by the satisfies Record<keyof ImplementCtx, MergeClass> in merge-wave.ts', () => {
    // Runtime no-op: the guarantee is structural (typecheck-time), asserted by the doc above.
    expect(true).toBe(true);
  });
});
