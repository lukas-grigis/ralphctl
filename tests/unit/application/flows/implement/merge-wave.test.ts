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
import {
  adoptPersistedBlocks,
  forkCtx,
  implementBranchId,
  mergeImplementWave,
  ownedTask,
} from '@src/application/flows/implement/merge-wave.ts';

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

/**
 * A completed branch whose chain settled `settled` into its final state — the branch's outcome ctx
 * carries ONLY its own task, exactly like the real branch body (`buildWorktreeBranch`) narrows it.
 */
const completedBranch = (base: ImplementCtx, settled: Task): BranchOutcome<ImplementCtx> => ({
  id: implementBranchId(settled.id),
  status: 'completed',
  ctx: { ...base, tasks: [settled] },
});

/**
 * A NON-fatal failed branch, shaped exactly as the real scheduler produces it (`toOutcome` passes
 * `runner.ctx`, which the runner never advances past `initialCtx` on a failed step — see
 * `runner.ts`): `ctx` is `base` VERBATIM, carrying every task at its pre-branch status, not just the
 * one this branch was working on.
 */
const failedBranch = (taskId: Task['id'], base: ImplementCtx, error: DomainError): BranchOutcome<ImplementCtx> => ({
  id: implementBranchId(taskId),
  status: 'failed',
  ctx: base,
  error,
});

const absorbedError = new InvalidStateError({
  entity: 'task',
  currentState: 'x',
  attemptedAction: 'y',
  message: 'absorbed',
});

describe('mergeImplementWave', () => {
  it('overlays each completed branch task onto base.tasks by id', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const base = makeBaseCtx([t1, t2]);

    const t1Settled: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    const t2Settled: Task = { ...makeDoneTask({ name: 't2' }), id: t2.id };

    const merged = mergeImplementWave(base, [completedBranch(base, t1Settled), completedBranch(base, t2Settled)]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    expect(merged.tasks?.find((t) => t.id === t2.id)?.status).toBe('done');
  });

  it('is commutative over disjoint completed branches — shuffling outcomes yields an identical merged ctx', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const t3 = makeTodoTask({ name: 't3' });
    const base = makeBaseCtx([t1, t2, t3]);

    const settle = (src: Task, model: Task): Task => ({ ...model, id: src.id });
    const o1 = completedBranch(base, settle(t1, makeDoneTask({ name: 't1' })));
    const o2 = completedBranch(base, settle(t2, blockedFrom(makeInProgressTaskWithRunningAttempt())));
    const o3 = completedBranch(base, settle(t3, makeDoneTask({ name: 't3' })));

    const inOrder = mergeImplementWave(base, [o1, o2, o3]);
    const shuffledA = mergeImplementWave(base, [o3, o1, o2]);
    const shuffledB = mergeImplementWave(base, [o2, o3, o1]);

    expect(shuffledA).toStrictEqual(inOrder);
    expect(shuffledB).toStrictEqual(inOrder);
  });

  it('is commutative even with a REALISTIC failed outcome mixed in (its full-base ctx contributes nothing)', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const t3 = makeTodoTask({ name: 't3' });
    const base = makeBaseCtx([t1, t2, t3]);

    const t1Settled: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    const t3Settled: Task = { ...makeDoneTask({ name: 't3' }), id: t3.id };
    const o1 = completedBranch(base, t1Settled);
    const o2 = failedBranch(t2.id, base, absorbedError);
    const o3 = completedBranch(base, t3Settled);

    const inOrder = mergeImplementWave(base, [o1, o2, o3]);
    const shuffledA = mergeImplementWave(base, [o3, o1, o2]);
    const shuffledB = mergeImplementWave(base, [o2, o3, o1]);

    expect(shuffledA).toStrictEqual(inOrder);
    expect(shuffledB).toStrictEqual(inOrder);
  });

  it('carries sprint-scoped fields straight from base', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, [completedBranch(base, { ...makeDoneTask(), id: t1.id })]);

    expect(merged.sprintId).toBe(base.sprintId);
    expect(merged.sprint).toBe(base.sprint);
    expect(merged.execution).toBe(base.execution);
    expect(merged.progressFile).toBe(base.progressFile);
  });

  it('clears per-task single-slot and signal-accum fields in the merged ctx', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, [completedBranch(base, { ...makeDoneTask(), id: t1.id })]);

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

  it('a failed branch (no error — killed mid-flight) leaves its task untouched so it resets/re-runs', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const base = makeBaseCtx([t1, t2]);

    const t1Settled: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    const killed: BranchOutcome<ImplementCtx> = { id: implementBranchId(t2.id), status: 'failed', ctx: base };

    const merged = mergeImplementWave(base, [completedBranch(base, t1Settled), killed]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    // task-2 must be the ORIGINAL base task (still todo) — the killed branch's `ctx` (== base)
    // contributes nothing, even though it nominally still carries a `t2` entry.
    const t2Merged = merged.tasks?.find((t) => t.id === t2.id);
    expect(t2Merged).toBe(t2);
    expect(t2Merged?.status).toBe('todo');
  });

  it('a NON-fatal failed branch (error present) still contributes nothing — its task keeps the base copy', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);

    const merged = mergeImplementWave(base, [failedBranch(t1.id, base, absorbedError)]);

    // Per the real scheduler contract a failed outcome's `ctx` is the runner's `initialCtx` — never
    // a transition — so the merge must NOT read `blocked` (or any other status) out of it. Any block
    // this branch's leaves already persisted to disk is picked up separately by the epilogue's
    // `adopt-persisted-blocks` leaf, not by this reducer.
    expect(merged.tasks?.find((t) => t.id === t1.id)).toBe(t1);
    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('todo');
  });

  it('a failed branch never reverts a sibling that a DIFFERENT branch already completed earlier in declaration order', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeInProgressTaskWithRunningAttempt();
    const base = makeBaseCtx([t1, t2]);

    const t1Done: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    const outcomes: ReadonlyArray<BranchOutcome<ImplementCtx>> = [
      completedBranch(base, t1Done),
      failedBranch(t2.id, base, absorbedError),
    ];

    const merged = mergeImplementWave(base, outcomes);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    expect(merged.tasks?.find((t) => t.id === t2.id)).toBe(t2);
  });

  it('a completed outcome contributes ONLY the task its branch owns, even if its ctx nominally carries a sibling too', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const base = makeBaseCtx([t1, t2]);

    const t1Done: Task = { ...makeDoneTask({ name: 't1' }), id: t1.id };
    // A stale, DIFFERENT-OBJECT copy of t2 sitting on the same outcome ctx (as `forkCtx` would leave
    // it before narrowing) — the merge must never read it.
    const staleT2: Task = { ...t2, name: 'should-not-be-read' };
    const outcome: BranchOutcome<ImplementCtx> = {
      id: implementBranchId(t1.id),
      status: 'completed',
      ctx: { ...base, tasks: [t1Done, staleT2] },
    };

    const merged = mergeImplementWave(base, [outcome]);

    expect(merged.tasks?.find((t) => t.id === t1.id)?.status).toBe('done');
    expect(merged.tasks?.find((t) => t.id === t2.id)).toBe(t2);
  });

  it('returns base.tasks unchanged when there are no outcomes', () => {
    const t1 = makeTodoTask();
    const base = makeBaseCtx([t1]);
    const merged = mergeImplementWave(base, []);

    expect(merged.tasks?.map((t) => t.id)).toStrictEqual([t1.id]);
    expect(merged.tasks?.[0]?.status).toBe('todo');
  });
});

describe('ownedTask', () => {
  it('finds the task whose id encodes to the given branch id', () => {
    const t1 = makeTodoTask({ name: 't1' });
    const t2 = makeTodoTask({ name: 't2' });
    const ctx = makeBaseCtx([t1, t2]);

    expect(ownedTask(implementBranchId(t1.id), ctx)).toBe(t1);
    expect(ownedTask(implementBranchId(t2.id), ctx)).toBe(t2);
  });

  it('returns undefined when no task matches or tasks is undefined', () => {
    const t1 = makeTodoTask();
    expect(ownedTask('task-does-not-exist', makeBaseCtx([t1]))).toBeUndefined();
    expect(ownedTask(implementBranchId(t1.id), { sprintId: sprint.id })).toBeUndefined();
  });
});

describe('adoptPersistedBlocks', () => {
  it('substitutes the persisted row when an in-memory in_progress/todo task is BLOCKED on disk', () => {
    const inMemory = makeInProgressTaskWithRunningAttempt();
    const persistedBlocked = blockedFrom(inMemory);

    const result = adoptPersistedBlocks([inMemory], [persistedBlocked]);

    expect(result[0]).toBe(persistedBlocked);
  });

  it('leaves a todo task unchanged when its persisted row is also todo', () => {
    const t = makeTodoTask();
    const result = adoptPersistedBlocks([t], [t]);
    expect(result[0]).toBe(t);
  });

  it('never adopts a persisted done over an in-memory blocked (fold-conflict) task', () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const blocked = blockedFrom(inProgress);
    const persistedDone: Task = { ...makeDoneTask(), id: blocked.id };

    const result = adoptPersistedBlocks([blocked], [persistedDone]);

    expect(result[0]).toBe(blocked);
  });

  it('never adopts a persisted done over an in-memory in_progress task (an unfolded commit must re-run)', () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const persistedDone: Task = { ...makeDoneTask(), id: inProgress.id };

    const result = adoptPersistedBlocks([inProgress], [persistedDone]);

    expect(result[0]).toBe(inProgress);
  });

  it('leaves a task unchanged when it has no persisted row at all', () => {
    const t = makeInProgressTaskWithRunningAttempt();
    const result = adoptPersistedBlocks([t], []);
    expect(result[0]).toBe(t);
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
 * Compile-time guard demonstration. `mergeImplementWave` and `forkCtx` both build their
 * sprint-scoped slice by spreading `projectSprintScopedFields(base)` (see
 * `sprint-scoped-projection.ts`) — the ONLY place either function reads a `'sprint'`-classified
 * field off `base`. That module's internal `CTX_FIELD_CLASS` object is
 * `satisfies Record<keyof ImplementCtx, MergeClass>`, so adding a new `ImplementCtx` field without
 * classifying it there is a TYPE ERROR (classification is exhaustive).
 *
 * Classification alone is not enough to force the PROJECTION to keep up (every `ImplementCtx` field
 * except `sprintId` is optional, so a hand-written return object can legally omit an optional key)
 * — which is exactly the gap this guard closes. `projectSprintScopedFields` declares its return
 * type as `Required<Pick<ImplementCtx, SprintScopedKey>>`, where `SprintScopedKey` is derived by
 * mapped type from the fields classified `'sprint'`. `Required<>` strips the optional modifier, so
 * every sprint-scoped key MUST be explicitly present in the returned object literal — omitting one
 * is a compile error, not a silently-accepted gap.
 *
 * The block below documents what happens if a NEW field is classified `'sprint'` but the projection
 * function is not updated to assign it. It cannot be left uncommented in a green suite (by design it
 * would fail typecheck), so it is preserved here as the contract record:
 *
 *   // In ctx.ts, adding:                readonly someNewField?: string | undefined;
 *   // In sprint-scoped-projection.ts's CTX_FIELD_CLASS, classifying:  someNewField: SPRINT,
 *   // …without adding `someNewField: ctx.someNewField` to `projectSprintScopedFields`'s return
 *   // object produces, at `pnpm typecheck`:
 *   //   error TS2741: Property 'someNewField' is missing in type '{ sprintId: …; … }' but
 *   //   required in type 'Required<Pick<ImplementCtx, SprintScopedKey>>'.
 *
 * This `expectTypeOf`-free note is the test surface for the guard — the actual enforcement is the
 * `Required<Pick<…>>` return type in sprint-scoped-projection.ts, verified every `pnpm typecheck`.
 */
describe('exhaustiveness guard (compile-time)', () => {
  it('is enforced by projectSprintScopedFields returning Required<Pick<ImplementCtx, SprintScopedKey>>', () => {
    // Runtime no-op: the guarantee is structural (typecheck-time), asserted by the doc above.
    expect(true).toBe(true);
  });

  it('both mergeImplementWave and forkCtx carry an unset sprint-scoped field through as undefined, not a stale prior value', () => {
    // `setupVerifiedRepoIdsThisRun` / `priorLearnings` are deliberately left unset on this base
    // (unlike makeBaseCtx, which always populates every sprint-scoped field) to exercise the
    // projection's handling of an absent optional field through the shared helper.
    const t1 = makeTodoTask();
    const base: ImplementCtx = {
      sprintId: sprint.id,
      sprint,
      execution: makeExecution(sprint.id),
      progressFile: absolutePath('/sprints/s1/progress.md'),
      tasks: [t1],
    };

    const merged = mergeImplementWave(base, []);
    const { ctx: forked } = forkCtx(
      base,
      { path: absolutePath('/repos/main'), name: 'main-repo' },
      absolutePath('/repos/.worktrees/wt-1')
    );

    expect(merged.setupVerifiedRepoIdsThisRun).toBeUndefined();
    expect(merged.priorLearnings).toBeUndefined();
    expect(forked.setupVerifiedRepoIdsThisRun).toBeUndefined();
    expect(forked.priorLearnings).toBeUndefined();
    expect(merged.setupTreeRecords).toBeUndefined();
    expect(forked.setupTreeRecords).toBeUndefined();
  });

  it("carries the main checkout's recorded setup answer into every fork and across every merge", () => {
    const t1 = makeTodoTask();
    const setupTreeRecords: ImplementCtx['setupTreeRecords'] = new Map([
      [t1.repositoryId, { outcome: 'stashed', seenPaths: ['pnpm-lock.yaml'], seenPathsTruncated: false }],
    ]);
    const base: ImplementCtx = { ...makeBaseCtx([t1]), setupTreeRecords };
    const settled: Task = { ...makeDoneTask(), id: t1.id };

    const { ctx: forked } = forkCtx(
      base,
      { path: absolutePath('/repos/main'), name: 'main-repo' },
      absolutePath('/repos/.worktrees/wt-1')
    );
    const merged = mergeImplementWave(base, [completedBranch(base, settled)]);
    const nextFork = forkCtx(
      merged,
      { path: absolutePath('/repos/main'), name: 'main-repo' },
      absolutePath('/repos/.worktrees/wt-2')
    ).ctx;

    expect(forked.setupTreeRecords).toBe(setupTreeRecords);
    expect(merged.setupTreeRecords).toBe(setupTreeRecords);
    expect(nextFork.setupTreeRecords).toBe(setupTreeRecords);
  });
});
