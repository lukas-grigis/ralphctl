import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { UpdateTask } from '@src/domain/repository/task/update-task.ts';
import type { GitRunResult, GitRunner } from '@src/integration/io/git-runner.ts';
import { createRunner } from '@src/application/chain/run/runner.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import type { RepoExecConfig } from '@src/application/flows/implement/leaves/resolve-repo.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import {
  buildWorktreeBranch,
  createFoldQueue,
  worktreePathFor,
  type BuildWaveBranchesDeps,
} from '@src/application/flows/implement/wave-branch.ts';
import { absolutePath, makeDoneTask, makePlannedSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

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

const stubBus = (): EventBus => ({ publish: () => {}, subscribe: () => () => {} });

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

/** Records every (sprintId, task) passed to `update` — the pointer-persistence side of quarantine. */
const recordingTaskRepo = (): UpdateTask & { calls: number; saved: Task[] } => {
  const state = {
    calls: 0,
    saved: [] as Task[],
    async update(_sprintId: SprintId, task: Task) {
      state.calls += 1;
      state.saved.push(task);
      return Result.ok(undefined);
    },
  };
  return state as unknown as UpdateTask & { calls: number; saved: Task[] };
};

/**
 * A git runner that records `(cwd, argv)` for every call — unlike the sibling `wave-branch.test.ts`
 * fake, cwd matters here: the whole point of the fix is that the stash runs against the WORKTREE
 * path, never `repo.path`. Answers `status --porcelain` per `opts.dirty`, `merge --ff-only` /
 * `cherry-pick` per `opts.foldConflict`, and every stash / worktree / branch call with success.
 */
const fakeGitRecordingCwd = (
  opts: { dirty?: boolean; foldConflict?: boolean } = {}
): { runner: GitRunner; calls: Array<{ cwd: string; args: string[] }> } => {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const ok = (stdout = '', exitCode = 0, stderr = ''): Result<GitRunResult, StorageError> =>
    Result.ok({ stdout, stderr, exitCode });
  const conflict = (): Result<GitRunResult, StorageError> => ok('CONFLICT (content)', 1, 'cherry-pick failed');
  const runner: GitRunner = {
    async run(cwd, args) {
      calls.push({ cwd: String(cwd), args: [...args] });
      const [a, b] = args;
      if (a === 'status') return ok(opts.dirty === true ? ' M leftover.ts\n' : '');
      if (a === 'merge' && b === '--ff-only') return opts.foldConflict === true ? ok('not ff', 1) : ok();
      if (a === 'merge-base') return ok('a'.repeat(40));
      if (a === 'cherry-pick') return opts.foldConflict === true ? conflict() : ok();
      return ok(); // worktree add/remove/prune, branch -D, stash push — all succeed.
    },
  };
  return { runner, calls };
};

const makeDeps = (runner: GitRunner, taskRepo: UpdateTask, appendFile: AppendFile): BuildWaveBranchesDeps => ({
  implement: { gitRunner: runner, taskRepo, appendFile, logger: noopLogger } as unknown as ImplementDeps,
  eventBus: stubBus(),
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
    const deps = makeDeps(git.runner, taskRepo, append.fn);

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

    expect(git.calls.some((c) => c.args[0] === 'status')).toBe(true); // the dirty-tree check ran…
    expect(git.calls.some((c) => c.args[0] === 'stash')).toBe(false); // …but found nothing to stash.
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
    expect(git.calls.some((c) => c.args[0] === 'stash')).toBe(false);
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

  it('a user abort landing right after the subchain settles the task blocked STILL quarantines the dirty diff, and the AbortError still propagates', async () => {
    // Regression: on abort, the quarantine used to be skipped while `cleanupWorktree`'s force-remove ran
    // unconditionally — destroying an already-settled, already-persisted block's rejected diff for
    // no reason. `foldStep` (`worktree-fold.ts`) checks `signal?.aborted` FIRST, before it even
    // looks at the task's status, so a blocked task — which never reaches real fold work — still
    // turns the branch's OVERALL result into `Result.error(AbortError)` once the signal fires in
    // the tail between the subchain settling and the fold step running. This fakes exactly that
    // tail: the subchain settles the task `blocked` (one turn ran, dirty tree) and fires the abort
    // BEFORE returning, so by the time `withWorktree`'s body reaches the fold step the signal is
    // already set — `buildWorktreeBranch`'s `onSettled` side-channel is what lets the teardown
    // still see the settled ctx despite that.
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
});
