import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import { sequential } from '@src/application/chain/build/sequential.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import { dependencyGateLeaf } from '@src/application/flows/implement/leaves/dependency-gate.ts';
import { settleAttemptLeaf } from '@src/application/flows/implement/leaves/settle-attempt.ts';
import { startAttemptLeaf } from '@src/application/flows/implement/leaves/start-attempt.ts';
import {
  buildWorktreeBranch,
  createFoldQueue,
  worktreePathFor,
  type BuildWaveBranchesDeps,
} from '@src/application/flows/implement/wave-branch.ts';
import {
  absolutePath,
  commitSha,
  FIXED_LATER,
  makeDoneTask,
  makePlannedSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import {
  abortLandsIn,
  attemptSettlesForRetry,
  commitLandsIn,
  fakeGitRecordingCwd,
  recordingTaskRepo,
  turnEndedBlocked,
} from '@tests/fixtures/implement-parallel.ts';

/**
 * Regression coverage for the parallel-path data-loss fix: a task that ends `blocked` inside a
 * worktree used to have its rejected diff force-deleted (`git worktree remove --force`) with
 * nothing quarantined first, and — on a fold conflict — the very branch ref its `blockedReason`
 * pointed at was then also deleted (`git branch -D`). These tests pin, at the `buildWorktreeBranch`
 * seam (real for production, fake only at the git-runner boundary):
 *
 *  - a blocked task with an actual rejected diff gets that diff stashed OUT OF THE WORKTREE before
 *    the worktree is removed, with the recovery pointer recorded on the task and journaled;
 *  - the throwaway branch ref survives cleanup whenever the task ends blocked (fold conflict OR a
 *    self-block), regardless of whether there was anything to stash;
 *  - a task that settles normally (`done`) is completely unaffected — same cleanup as before.
 */

const repo: RepoExecConfig = { path: absolutePath('/repos/main'), name: 'main-repo' };
const PROGRESS = absolutePath('/tmp/sprint/progress.md');

const stubBus = (events: AppEvent[] = []): EventBus => ({
  publish: (e) => events.push(e),
  subscribe: () => () => {},
});

/** Capturing AppendFile — records every (path, text) append for journal-pointer assertions. */
const capturingAppend = (): { fn: AppendFile; appended: Array<{ path: string; text: string }> } => {
  const appended: Array<{ path: string; text: string }> = [];
  return {
    appended,
    fn: async (path, text) => {
      appended.push({ path: String(path), text });
      return Result.ok(undefined);
    },
  };
};

const makeDeps = (
  runner: GitRunner,
  taskRepo: TaskRepository,
  appendFile: AppendFile,
  eventBus: EventBus = stubBus()
): BuildWaveBranchesDeps => ({
  implement: {
    gitRunner: runner,
    taskRepo,
    appendFile,
    logger: noopLogger,
    clock: () => FIXED_LATER,
    eventBus,
  } as unknown as ImplementDeps,
  eventBus,
  foldQueue: createFoldQueue(),
});

const runBranch = async (
  element: Element<ImplementCtx>,
  base: ImplementCtx
): Promise<{ status: string; ctx: ImplementCtx }> => {
  const runner = createRunner<ImplementCtx>({ id: 'branch', element, initialCtx: base });
  await runner.start();
  return { status: runner.status, ctx: runner.ctx };
};

const sprint = makePlannedSprint();

// `genEvalTurn` is deliberately NOT a `baseCtx` field: `forkCtx` clears it (per-task scratch) the
// instant the branch forks, so only what the FAKE subchain below stamps on its RETURNED ctx (the
// same place the real `generator` leaf stamps it, mid-subchain) can ever reach the fold step.
//
// `progressFile` is likewise deliberately NOT a `baseCtx` field — this is the production shape:
// `ImplementCtx.progressFile` is never populated anywhere in the real implement chain (nothing
// writes it; the ONLY production seed for the top-level ctx is `{ sprintId }`, and the prologue
// never stamps it either). `buildWorktreeBranch` takes it as an explicit PARAMETER instead (see
// `PROGRESS` passed at each call site below) precisely so the quarantine step below does not
// depend on a ctx field production never sets.
const baseCtx = (tasks: readonly Task[]): ImplementCtx => ({
  sprintId: sprint.id,
  sprint,
  tasks,
});

/** A fake subchain that settles `taskId` blocked and stamps `ctx.genEvalTurn` — an own self-block. */
const selfBlockingSubchain = (
  taskId: Task['id'],
  reason: string,
  genEvalTurn: number
): ((worktreeRepo: RepoExecConfig) => Element<ImplementCtx>) => {
  return () => ({
    name: `fake-self-block-${String(taskId)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      const current = ctx.tasks?.find((t) => t.id === taskId);
      if (current === undefined) throw new Error('test setup: task missing from ctx');
      const blocked = markTaskBlocked(current, reason, 'own');
      if (!blocked.ok) throw blocked.error;
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === taskId ? blocked.value : t));
      return Result.ok({ ctx: { ...ctx, tasks, genEvalTurn }, trace: [] });
    },
  });
};

/**
 * A fake subchain that settles `taskId` `done` — the fold step then decides done/conflict. An
 * optional `genEvalTurn` simulates the real `generator` leaf having bumped the turn counter before
 * landing the commit (production shape for a task that reaches `done`).
 */
const doneSubchain = (
  taskId: Task['id'],
  genEvalTurn?: number
): ((worktreeRepo: RepoExecConfig) => Element<ImplementCtx>) => {
  return () => ({
    name: `fake-done-${String(taskId)}`,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      const done: Task = { ...makeDoneTask(), id: taskId };
      const tasks = (ctx.tasks ?? []).map((t) => (t.id === taskId ? done : t));
      return Result.ok({ ctx: { ...ctx, tasks, ...(genEvalTurn !== undefined ? { genEvalTurn } : {}) }, trace: [] });
    },
  });
};

const branchDeleteCount = (calls: Array<{ cwd: string; args: string[] }>, ref: string): number =>
  calls.filter((c) => c.args[0] === 'branch' && c.args[1] === '-D' && c.args[2] === ref).length;

/** Whether anything was pushed onto the stash — a read-only `stash list` doesn't count. */
const stashPushed = (calls: Array<{ cwd: string; args: string[] }>): boolean =>
  calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'push');

describe('wave-branch worktree teardown — blocked-task quarantine + branch retention', () => {
  it('own self-block with a dirty worktree: stashes into the WORKTREE, records the pointer, keeps the branch ref', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-selfblock';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo();
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      ref,
      PROGRESS,
      selfBlockingSubchain(task.id, 'verify failed: 2 tests red', 2)
    );
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');

    const message = quarantineStashMessage(sprint.id, task.id);
    // Stashed FROM THE WORKTREE (not repo.path) — the whole point of the fix.
    const stashCall = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(stashCall).toBeDefined();
    expect(stashCall?.cwd).toBe(String(wt));
    expect(stashCall?.cwd).not.toBe(String(repo.path));
    expect(stashCall?.args).toStrictEqual(['stash', 'push', '-u', '-m', message]);

    // The recovery pointer was persisted (record-quarantine) AND folded back into the returned ctx —
    // otherwise the epilogue's later tasks.json write would clobber the persisted pointer.
    expect(taskRepo.calls).toBe(1);
    expect((settled as { blockedReason: string }).blockedReason).toContain(message);
    expect((settled as { blockedReason: string }).blockedReason).toContain('verify failed: 2 tests red');

    // Durable journal breadcrumb, same as the serial path's leaf.
    expect(append.appended).toHaveLength(1);
    expect(append.appended[0]?.path).toBe(String(PROGRESS));
    expect(append.appended[0]?.text).toContain(message);

    // Worktree removed, but the branch ref survives — only the ONE defensive pre-delete
    // (`setupWorktree`'s leaked-ref guard) ran, not a second one from cleanup.
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove' && c.args[2] === '--force')).toBe(
      true
    );
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('own self-block with a CLEAN worktree: stash no-ops, no pointer recorded, branch ref still kept', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-selfblock-clean';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: false });
    const taskRepo = recordingTaskRepo();
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      ref,
      PROGRESS,
      selfBlockingSubchain(task.id, 'baseline broken', 1)
    );
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');
    // Clean tree → `gitStashPush` never issues the actual `stash push` subcommand.
    expect(git.calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'push')).toBe(false);
    expect(taskRepo.calls).toBe(0);
    expect(append.appended).toHaveLength(0);
    // blockedReason unchanged — no pointer to append.
    expect((settled as { blockedReason: string }).blockedReason).toBe('baseline broken');

    // The branch-retention decision is independent of whether anything was actually stashed.
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('fold conflict: keeps the branch ref (the only place the settled commits live); stash attempt no-ops on the clean tree', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-conflict';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ foldConflict: true }); // dirty defaults false — worktree is clean.
    const taskRepo = recordingTaskRepo();
    const append = capturingAppend();
    const events: AppEvent[] = [];
    const deps = makeDeps(git.runner, taskRepo, append.fn, stubBus(events));

    // `genEvalTurn: 2` mirrors production: the subchain ran turns and committed BEFORE the fold
    // conflict re-blocked the already-`done` task, so the zero-turn discriminant does NOT skip this
    // — the quarantine IS attempted (see the `status` assertion below) and no-ops because the
    // worktree's own tree is clean (everything was already committed by the subchain).
    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, doneSubchain(task.id, 2));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');
    expect((settled as { blockedReason: string }).blockedReason).toContain('fold conflict');
    // The fold conflict is announced exactly once, at the fold step that decided it.
    const blockedEvents = events.filter((e) => e.type === 'task-blocked');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({ taskId: String(task.id), blockKind: 'own', at: FIXED_LATER });
    expect(blockedEvents[0]).toMatchObject({ reason: expect.stringMatching(/^fold conflict/) });

    expect(git.calls.some((c) => c.args[0] === 'status')).toBe(true); // the dirty-tree check ran…
    expect(stashPushed(git.calls)).toBe(false); // …but found nothing to stash.
    expect(taskRepo.calls).toBe(0);
    expect(append.appended).toHaveLength(0);

    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    // The ref is what the blockedReason points at — deleting it here would strand verified,
    // committed work in the reflog. Only the pre-add defensive delete ran.
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a task that settles done is unaffected — cleanup still deletes the throwaway branch ref', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-done';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd();
    const taskRepo = recordingTaskRepo();
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, doneSubchain(task.id));
    const { status, ctx } = await runBranch(branch, baseCtx([task]));

    expect(status).toBe('completed');
    expect(ctx.tasks?.find((t) => t.id === task.id)?.status).toBe('done');
    expect(stashPushed(git.calls)).toBe(false);
    expect(taskRepo.calls).toBe(0);
    // Pre-add defensive delete AND the post-cleanup delete both ran — regression guard: a normal,
    // non-blocked task's branch cleanup is completely unaffected by this fix.
    expect(branchDeleteCount(git.calls, ref)).toBe(2);
  });

  it('quarantine reads progressFile off the buildWorktreeBranch PARAMETER, never off ctx — the production wiring', async () => {
    // Regression fence for the fix that made this parallel-path quarantine reachable in
    // production at all: `ImplementCtx.progressFile` is never populated anywhere in the real
    // implement chain (the launcher seeds the top-level ctx with `{ sprintId }` only), so a
    // version of `withWorktree` that derives `progressFile` off the settled ctx is structurally
    // dead code no matter how faithfully a test's `baseCtx` happens to omit the field. Proving
    // that goes further than merely omitting it: stamp a DECOY path onto ctx.progressFile (a fold
    // conflict / self-block never clears it — it rides straight through) and assert the journal
    // breadcrumb landed on the CONSTRUCTOR argument, not the decoy.
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-wiring';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo();
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);

    const decoyProgressFile = absolutePath('/should-not-be-used/progress.md');
    const ctxWithDecoy: ImplementCtx = { ...baseCtx([task]), progressFile: decoyProgressFile };

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      ref,
      PROGRESS,
      selfBlockingSubchain(task.id, 'verify failed: wiring check', 1)
    );
    const { status, ctx } = await runBranch(branch, ctxWithDecoy);

    expect(status).toBe('completed');
    const settled = ctx.tasks?.find((t) => t.id === task.id);
    expect(settled?.status).toBe('blocked');
    // The stash still ran (proves quarantine actually fired, not merely no-oped).
    expect(git.calls.some((c) => c.args[0] === 'stash' && c.args[1] === 'push')).toBe(true);
    // The journal breadcrumb — and hence `runQuarantineBlockedDiff`'s `opts.progressFile` — used
    // the CONSTRUCTOR parameter, never the decoy value that was sitting right there on ctx.
    expect(append.appended).toHaveLength(1);
    expect(append.appended[0]?.path).toBe(String(PROGRESS));
    expect(append.appended[0]?.path).not.toBe(String(decoyProgressFile));
  });

  it('a user abort landing between the subchain returning and the fold step STILL quarantines the dirty diff, and the AbortError still propagates', async () => {
    // Regression: on abort, the quarantine used to be skipped while `cleanupWorktree`'s force-remove ran
    // unconditionally — destroying an already-settled, already-persisted block's rejected diff for
    // no reason. `foldStep` (`worktree-fold.ts`) checks `signal?.aborted` FIRST, before it even
    // looks at the task's status, so a blocked task — which never reaches real fold work — still
    // turns the branch's OVERALL result into `Result.error(AbortError)` once the signal fires in
    // the tail between the subchain returning and the fold step running. This fakes exactly that
    // tail: the subchain settles the task `blocked` (one turn ran, dirty tree), fires the abort,
    // and still returns ok — the abort landed after its last leaf's own signal check — so the
    // teardown reads the settled ctx off `buildWorktreeBranch`'s `onSettled` side-channel. An abort
    // landing INSIDE the subchain is a different window (the subchain itself errors); see the
    // persisted-state tests below.
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-abort-blocked';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo();
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);
    const controller = new AbortController();

    const selfBlockThenAbort = (): ((worktreeRepo: RepoExecConfig) => Element<ImplementCtx>) => () => ({
      name: 'fake-self-block-then-abort',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        const current = ctx.tasks?.find((t) => t.id === task.id);
        if (current === undefined) throw new Error('test setup: task missing from ctx');
        const blocked = markTaskBlocked(current, 'verify failed: aborted mid-teardown', 'own');
        if (!blocked.ok) throw blocked.error;
        const tasks = (ctx.tasks ?? []).map((t) => (t.id === task.id ? blocked.value : t));
        // Fire the abort the instant the subchain settles — before the fold step ever runs, so
        // the branch's overall result becomes `Result.error(AbortError)`.
        controller.abort();
        return Result.ok({ ctx: { ...ctx, tasks, genEvalTurn: 1 }, trace: [] });
      },
    });

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, selfBlockThenAbort());
    const result = await branch.execute(baseCtx([task]), controller.signal);

    // The AbortError propagates verbatim — it is never swallowed or converted into a `completed` /
    // `blocked` outcome by the quarantine step.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);

    // The quarantine ran anyway: the rejected diff was stashed OUT OF THE WORKTREE, the recovery
    // pointer was persisted, and the journal breadcrumb was written — exactly as the non-abort
    // self-block case above, because quarantine is pure local git work with no signal-aware
    // waiting of its own (see `runQuarantineBlockedDiff`'s docstring).
    const message = quarantineStashMessage(sprint.id, task.id);
    const stashCall = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(stashCall).toBeDefined();
    expect(stashCall?.cwd).toBe(String(wt));
    expect(taskRepo.calls).toBe(1);
    expect(append.appended).toHaveLength(1);
    expect(append.appended[0]?.text).toContain(message);

    // Cleanup still ran (force-removed the worktree) — but the branch ref survives, same as any
    // other blocked task, so the retained ref + the stash together are the recovery path.
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove' && c.args[2] === '--force')).toBe(
      true
    );
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a subchain that THROWS still tears the worktree down, and the ORIGINAL error propagates', async () => {
    // Regression: the teardown used to read a definite-assignment `let result!` before running
    // cleanup. The chain primitives re-throw every non-DomainError verbatim (`leaf.ts`) and
    // `buildSubchain` is constructed inside the body, so a projection bug anywhere in the per-task
    // subchain leaves that `result` unassigned — the read then raised
    // `TypeError: Cannot read properties of undefined (reading 'ok')`, which BOTH replaced the real
    // error AND skipped `cleanupWorktree`. The stranded `wt-<task>` dir + ref then wedged every
    // later launch of the task in `git worktree add` until an operator removed them by hand.
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-throw';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd();
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);

    const throwingSubchain = (): Element<ImplementCtx> => ({
      name: 'fake-throwing-subchain',
      execute(): Promise<ElementResult<ImplementCtx>> {
        throw new Error('projection bug');
      },
    });

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, throwingSubchain);

    // The ORIGINAL error, not a TypeError from the teardown reading an unassigned result.
    await expect(branch.execute(baseCtx([task]))).rejects.toThrow('projection bug');

    // …and the worktree was still force-removed, so the next launch can recreate it.
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove' && c.args[2] === '--force')).toBe(
      true
    );
    // The ref is kept: a throw means the fold never completed, so anything the subchain had already
    // committed lives on this ref alone (only `setupWorktree`'s defensive pre-delete ran).
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a teardown that THROWS on the success path runs exactly once — it never re-enters through the throw arm', async () => {
    // Regression: the settled-path teardown used to sit INSIDE the try that guards the body, so a
    // raw throw out of the teardown itself (`onTrace` / `taskRepo` / `appendFile` / the git runner —
    // the same class the throw arm exists for) was caught by that arm and ran the WHOLE teardown a
    // second time, with `result` lost: a second `git stash push` against a now-clean tree, a second
    // `worktree remove` against a removed dir, and `keepBranchRefReason` flipped to
    // `fold-incomplete` on a branch whose ref should have been deleted.
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-teardown-throw';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const removeCalls: string[] = [];
    const git = fakeGitRecordingCwd();
    const runner: GitRunner = {
      async run(cwd, args) {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          removeCalls.push(String(cwd));
          // A raw throw, not a `Result.error`: this is what an adapter blowing up looks like.
          throw new Error('git spawn exploded');
        }
        return git.runner.run(cwd, args);
      },
    };
    const deps = makeDeps(runner, recordingTaskRepo(), capturingAppend().fn);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, doneSubchain(task.id));

    // The teardown's own error propagates verbatim — nothing re-runs and re-throws in its place.
    await expect(branch.execute(baseCtx([task]))).rejects.toThrow('git spawn exploded');
    expect(removeCalls).toHaveLength(1);
  });

  it('an abort between a task settling done and its fold KEEPS the ref that holds the unfolded commits', async () => {
    // Regression: `foldStep` returns `abortedStep` on an already-aborted signal BEFORE folding, so
    // the branch's overall result is `Result.error(AbortError)` while the task itself settled
    // `done` — its verified commits are on THIS ref and nowhere else (nothing folded them onto the
    // sprint branch, and `captureDurableFold` skips a non-completed branch, so the epilogue rewrites
    // the task back to its pre-wave status). Cleanup used to delete the ref anyway, orphaning that
    // work and paying a full generator/evaluator spend to redo it on the next launch.
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-abort-done';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd();
    const taskRepo = recordingTaskRepo();
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const doneThenAbort = (): Element<ImplementCtx> => ({
      name: 'fake-done-then-abort',
      async execute(ctx): Promise<ElementResult<ImplementCtx>> {
        const done: Task = { ...makeDoneTask(), id: task.id };
        const tasks = (ctx.tasks ?? []).map((t) => (t.id === task.id ? done : t));
        // Fire the abort the instant the subchain settles — the fold step never gets to fold.
        controller.abort();
        return Result.ok({ ctx: { ...ctx, tasks, genEvalTurn: 2 }, trace: [] });
      },
    });

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, doneThenAbort);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    // The fold really did not run…
    expect(git.calls.some((c) => c.args[0] === 'merge')).toBe(false);
    // …the worktree was still removed…
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    // …and the ref survived: only `setupWorktree`'s defensive pre-delete ran, never a cleanup one.
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
    // Nothing to quarantine — the task settled `done`, not `blocked`.
    expect(stashPushed(git.calls)).toBe(false);
    expect(taskRepo.calls).toBe(0);
  });
});

/**
 * The abort window INSIDE the per-task subchain. The real subchain is `sequential` / `loop` all the
 * way down, and `settle-attempt` (which persists `blocked`) is followed by more leaves —
 * append-learnings, progress-journal, the uninstall leaves. An abort that lands in any of them makes
 * the whole subchain return `Result.error(AbortError)`, so no settled ctx ever reaches the teardown.
 * The persisted task is then the only record of how the task ended, and the teardown must read it
 * before `git worktree remove --force` destroys the diff.
 *
 * These subchains are built from the real `sequential` / `leaf` primitives and the real
 * start-attempt / settle-attempt / dependency-gate leaves, so they return exactly what production
 * returns once the signal fires.
 */
describe('wave-branch worktree teardown — abort inside the subchain, after the block is persisted', () => {
  const BLOCK_REASON = 'verify script failed: 3 tests red';

  /** Stand-in for a post-settle leaf that must never run once the abort landed. */
  const mustNotRun = (name: string, ran: { value: boolean }): Element<ImplementCtx> => ({
    name,
    async execute(ctx): Promise<ElementResult<ImplementCtx>> {
      ran.value = true;
      return Result.ok({ ctx, trace: [] });
    },
  });

  const startAttempt = (taskRepo: TaskRepository, id: TaskId): Element<ImplementCtx> =>
    startAttemptLeaf({ taskRepo, clock: () => FIXED_LATER, logger: noopLogger, eventBus: stubBus() }, id);

  const collectTrace = (): { onTrace: (entry: TraceEntry) => void; entries: TraceEntry[] } => {
    const entries: TraceEntry[] = [];
    return { entries, onTrace: (entry) => entries.push(entry) };
  };

  const worktreeRemoved = (calls: Array<{ cwd: string; args: string[] }>): boolean =>
    calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');

  it('an abort landing in a post-settle leaf still quarantines the persisted block and keeps the ref', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-abort-post-settle';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo([task]);
    const append = capturingAppend();
    const events: AppEvent[] = [];
    const bus = stubBus(events);
    const deps = makeDeps(git.runner, taskRepo, append.fn, bus);
    const controller = new AbortController();
    const journalRan = { value: false };

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [
        startAttempt(taskRepo, task.id),
        turnEndedBlocked(BLOCK_REASON),
        settleAttemptLeaf(
          { taskRepo, clock: () => FIXED_LATER, logger: noopLogger, eventBus: bus },
          { cwd: wt },
          task.id
        ),
        abortLandsIn(`append-learnings-${String(task.id)}`, controller),
        mustNotRun(`progress-journal-${String(task.id)}`, journalRan),
      ]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    // The subchain really did error out mid-way — no settled ctx reached the teardown.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    expect(journalRan.value).toBe(false);

    // Quarantined from the worktree anyway, off the persisted `blocked` row.
    const message = quarantineStashMessage(sprint.id, task.id);
    const stashCall = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(stashCall?.cwd).toBe(String(wt));
    expect(stashCall?.args).toStrictEqual(['stash', 'push', '-u', '-m', message]);
    const lastWrite = taskRepo.saved.at(-1);
    expect(lastWrite?.status).toBe('blocked');
    expect((lastWrite as { blockedReason: string }).blockedReason).toContain(BLOCK_REASON);
    expect((lastWrite as { blockedReason: string }).blockedReason).toContain(message);
    expect(append.appended).toHaveLength(1);
    expect(append.appended[0]?.text).toContain(message);

    // The stash was pushed BEFORE the worktree was removed, and the ref survives.
    const stashIdx = git.calls.findIndex((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    const removeIdx = git.calls.findIndex((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(stashIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(stashIdx);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);

    // Settle announced the block; the teardown's pointer write did not announce it again.
    expect(events.filter((e) => e.type === 'task-blocked')).toHaveLength(1);
  });

  it('an abort before the task blocked quarantines nothing — the persisted task is still in progress', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-abort-mid-attempt';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [
        startAttempt(taskRepo, task.id),
        abortLandsIn(`generator-${String(task.id)}`, controller),
      ]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    expect(taskRepo.saved.at(-1)?.status).toBe('in_progress');
    expect(stashPushed(git.calls)).toBe(false);
    expect(worktreeRemoved(git.calls)).toBe(true);
    // The fold never ran, so the ref is kept for whatever the attempt may have committed.
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a block this branch reached without opening an attempt is not quarantined', async () => {
    // The dependency gate blocks before any attempt starts, so nothing in this worktree is AI work —
    // a dirty tree here is setup-script output, not a rejected diff.
    const prerequisite = makeTodoTask({ name: 'prerequisite' });
    const task = makeTodoTask({ name: 'dependent', dependsOn: [prerequisite.id] });
    const ref = 'ralphctl/s1/wt-abort-upstream';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo([prerequisite, task]);
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);
    const controller = new AbortController();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [
        dependencyGateLeaf({ taskRepo, logger: noopLogger }, task.id),
        abortLandsIn(`task-runnable-${String(task.id)}`, controller),
      ]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([prerequisite, task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(taskRepo.saved.at(-1)).toMatchObject({ id: task.id, status: 'blocked', blockKind: 'upstream' });
    expect(stashPushed(git.calls)).toBe(false);
    expect(append.appended).toHaveLength(0);
    expect(worktreeRemoved(git.calls)).toBe(true);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a failed task lookup leaves a dirty worktree on disk, and the AbortError still propagates', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-lookup-fails';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const lookupError = new StorageError({ subCode: 'io', message: 'tasks.json unreadable' });
    const taskRepo = recordingTaskRepo([task], { fails: lookupError });
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();
    const trace = collectTrace();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [abortLandsIn('uninstall-skills', controller)]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal, trace.onTrace);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    // Nothing destroyed and nothing invented: no remove, no stash, no ref delete past setup's own.
    expect(worktreeRemoved(git.calls)).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
    // The skipped cleanup is visible on the trace, carrying the lookup failure.
    const cleanup = trace.entries.find((e) => e.elementName === `worktree-cleanup-${String(task.id)}`);
    expect(cleanup).toMatchObject({ status: 'failed', error: lookupError });
  });

  it('a task lookup that throws is handled the same way, and the original AbortError still propagates', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-lookup-throws';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true });
    const taskRepo = recordingTaskRepo([task], { throws: new Error('adapter exploded') });
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [abortLandsIn('uninstall-skills', controller)]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    expect(worktreeRemoved(git.calls)).toBe(false);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('a failed task lookup on a clean worktree removes it as usual and keeps the ref', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-lookup-fails-clean';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: false });
    const taskRepo = recordingTaskRepo([task], { fails: new StorageError({ subCode: 'io', message: 'unreadable' }) });
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [abortLandsIn('uninstall-skills', controller)]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, ref, PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(worktreeRemoved(git.calls)).toBe(true);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });
});

/**
 * The interrupted window AFTER `restore-blocked-diff` popped the task's quarantined diff: a
 * successful pop drops the stash entry, so the worktree holds the only copy. An abort (or error, or
 * throw) before that diff is committed or quarantined again leaves the persisted task
 * `in_progress`, and without a re-stash the teardown's `worktree remove --force` destroys it.
 *
 * Which branch had something to lose is decided from the stash list at branch start (the entry was
 * there) and at teardown (it's gone), plus the persisted task (an attempt opened by this branch,
 * no commit recorded since).
 */
describe('wave-branch worktree teardown — interrupted branch after a restore', () => {
  const startAttempt = (taskRepo: TaskRepository, id: TaskId): Element<ImplementCtx> =>
    startAttemptLeaf({ taskRepo, clock: () => FIXED_LATER, logger: noopLogger, eventBus: stubBus() }, id);

  const interruptedMidGenerator = (
    taskRepo: TaskRepository,
    task: Task,
    controller: AbortController,
    beforeAbort: ReadonlyArray<Element<ImplementCtx>> = []
  ): (() => Element<ImplementCtx>) => {
    return () =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [
        startAttempt(taskRepo, task.id),
        ...beforeAbort,
        abortLandsIn(`generator-${String(task.id)}`, controller),
      ]);
  };

  const indexOf = (calls: Array<{ cwd: string; args: string[] }>, a: string, b: string): number =>
    calls.findIndex((c) => c.args[0] === a && c.args[1] === b);

  it('re-stashes the restored diff from the worktree before removing it, and the AbortError still propagates', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-restored-abort';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    // Listed at branch start; gone at teardown — the attempt popped it into the worktree.
    const git = fakeGitRecordingCwd({ dirty: true, stashList: [{ messages: [message] }, { messages: [] }] });
    const taskRepo = recordingTaskRepo([task]);
    const append = capturingAppend();
    const deps = makeDeps(git.runner, taskRepo, append.fn);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      ref,
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);

    const push = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(push?.cwd).toBe(String(wt));
    expect(push?.args).toStrictEqual(['stash', 'push', '-u', '-m', message]);
    expect(indexOf(git.calls, 'worktree', 'remove')).toBeGreaterThan(indexOf(git.calls, 'stash', 'push'));

    // The task isn't blocked, so no pointer is written: the persisted task stays in progress and
    // the journal is untouched (the original quarantine breadcrumb already names this key).
    expect(taskRepo.saved.at(-1)?.status).toBe('in_progress');
    expect(taskRepo.saved.some((t) => t.status === 'blocked')).toBe(false);
    expect(append.appended).toHaveLength(0);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
  });

  it('takes the start snapshot against the main repo, before the worktree exists', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd();
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-snapshot',
      PROGRESS,
      doneSubchain(task.id)
    );
    await runBranch(branch, baseCtx([task]));

    const list = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'list');
    expect(list?.cwd).toBe(String(repo.path));
    expect(git.calls.indexOf(list!)).toBeLessThan(indexOf(git.calls, 'worktree', 'add'));
  });

  it('pushes nothing when the entry is still in the stash at teardown — the attempt never popped it', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    const git = fakeGitRecordingCwd({
      dirty: true,
      stashList: [{ messages: [message] }, { messages: ['ralphctl/s1/other/blocked-diff', message] }],
    });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-still-stashed',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('pushes nothing once the interrupted branch already committed — the restored diff landed with that commit', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    const git = fakeGitRecordingCwd({ dirty: true, stashList: [{ messages: [message] }, { messages: [] }] });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();
    const sha = commitSha('c0ffee'.padEnd(40, '0'));
    const committed = commitLandsIn(`commit-task-${String(task.id)}`, taskRepo, sprint.id, task.id, sha);

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-committed',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller, [committed])
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(taskRepo.saved.at(-1)?.attempts.at(-1)?.commitSha).toBe(sha);
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('re-stashes when an older entry is still under the key but one fewer than at branch start', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    // Two entries under the key at branch start; the attempt popped the newer one.
    const git = fakeGitRecordingCwd({
      dirty: true,
      stashList: [{ messages: [message, message] }, { messages: ['ralphctl/s1/other/blocked-diff', message] }],
    });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-older-entry',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    const push = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(push?.cwd).toBe(String(wt));
    expect(push?.args).toStrictEqual(['stash', 'push', '-u', '-m', message]);
    expect(indexOf(git.calls, 'worktree', 'remove')).toBeGreaterThan(indexOf(git.calls, 'stash', 'push'));
  });

  it('pushes nothing when the key lists as many entries at teardown as at branch start', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    const git = fakeGitRecordingCwd({
      dirty: true,
      stashList: [{ messages: [message, message] }, { messages: [message, message] }],
    });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-both-entries',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('re-stashes when an earlier attempt committed but the interrupted last attempt did not', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    // Attempt 1 popped one entry and committed it; attempt 2 popped the other and was interrupted.
    const git = fakeGitRecordingCwd({ dirty: true, stashList: [{ messages: [message, message] }, { messages: [] }] });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();
    const sha = commitSha('c0ffee'.padEnd(40, '0'));
    const firstAttempt = [
      commitLandsIn(`commit-task-${String(task.id)}`, taskRepo, sprint.id, task.id, sha),
      attemptSettlesForRetry(taskRepo, sprint.id, task.id, FIXED_LATER),
      startAttempt(taskRepo, task.id),
    ];

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-second-attempt',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller, firstAttempt)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    const persisted = taskRepo.saved.at(-1);
    expect(persisted?.status).toBe('in_progress');
    expect(persisted?.attempts.map((a) => a.commitSha)).toStrictEqual([sha, undefined]);
    const push = git.calls.find((c) => c.args[0] === 'stash' && c.args[1] === 'push');
    expect(push?.args).toStrictEqual(['stash', 'push', '-u', '-m', message]);
    expect(indexOf(git.calls, 'worktree', 'remove')).toBeGreaterThan(indexOf(git.calls, 'stash', 'push'));
  });

  it('pushes nothing for an interrupted branch that never opened an attempt', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    const git = fakeGitRecordingCwd({ dirty: true, stashList: [{ messages: [message] }, { messages: [] }] });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const subchain = (): Element<ImplementCtx> =>
      sequential<ImplementCtx>(`task-${String(task.id)}`, [
        abortLandsIn(`install-skills-${String(task.id)}`, controller),
      ]);

    const branch = buildWorktreeBranch(deps, repo, task, wt, 'ralphctl/s1/wt-no-attempt', PROGRESS, subchain);
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });

  it('keeps the worktree when the teardown cannot list the stash, and the AbortError still propagates', async () => {
    const task = makeTodoTask();
    const ref = 'ralphctl/s1/wt-list-fails';
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const message = quarantineStashMessage(sprint.id, task.id);
    const git = fakeGitRecordingCwd({
      dirty: true,
      stashList: [{ messages: [message] }, { failsWith: 'fatal: bad object refs/stash' }],
    });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();
    const entries: TraceEntry[] = [];

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      ref,
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal, (entry) => entries.push(entry));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error).toBeInstanceOf(AbortError);
    // Nothing destroyed: no push was attempted blind, no remove, no ref delete past setup's own.
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(branchDeleteCount(git.calls, ref)).toBe(1);
    const cleanup = entries.find((e) => e.elementName === `worktree-cleanup-${String(task.id)}`);
    expect(cleanup?.status).toBe('failed');
    expect(cleanup?.error?.message).toContain('bad object refs/stash');
  });

  it('a start snapshot that cannot list the stash leaves the teardown as it was — no re-stash', async () => {
    const task = makeTodoTask();
    const wt = worktreePathFor(absolutePath('/data/sprints/s1'), task.id);
    const git = fakeGitRecordingCwd({ dirty: true, stashList: [{ failsWith: 'fatal: not a git repository' }] });
    const taskRepo = recordingTaskRepo([task]);
    const deps = makeDeps(git.runner, taskRepo, capturingAppend().fn);
    const controller = new AbortController();

    const branch = buildWorktreeBranch(
      deps,
      repo,
      task,
      wt,
      'ralphctl/s1/wt-snapshot-fails',
      PROGRESS,
      interruptedMidGenerator(taskRepo, task, controller)
    );
    const result = await branch.execute(baseCtx([task]), controller.signal);

    expect(result.ok).toBe(false);
    expect(stashPushed(git.calls)).toBe(false);
    expect(git.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
  });
});
