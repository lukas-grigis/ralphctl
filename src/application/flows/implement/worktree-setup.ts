import { realpath } from 'node:fs/promises';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ElementResult } from '@src/application/chain/element.ts';
import type { OnStart, OnTrace, TraceEntry } from '@src/application/chain/trace.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import { publishTaskBlocked } from '@src/business/task/publish-task-blocked.ts';
import { gitWorktreeAdd, gitWorktreePrune, legacyGitWorktreeRef } from '@src/integration/io/git-operations.ts';
import { gitRenameBranch } from '@src/integration/io/git-ref-rescue.ts';
import { gitWorktreeList, type GitWorktreeEntry } from '@src/integration/io/git-worktree-list.ts';
import { pathExists } from '@src/integration/io/fs.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { BuildWaveBranchesDeps } from '@src/application/flows/implement/wave-branch.ts';
import { abortedStep } from '@src/application/flows/implement/worktree-fold.ts';
import { beginWorktreeSetupTreeCheck } from '@src/application/flows/implement/worktree-setup-tree.ts';
import { settleStaleWorktreeRefs, type StaleRefTarget } from '@src/application/flows/implement/worktree-stale-refs.ts';

// Everything a parallel branch does before its task body runs: create (or adopt) the worktree,
// then run the repo's setup script inside it. Either can block only this task.

/** The per-worktree setup a branch runs: the repo's script plus what its working-tree check needs. */
export interface WorktreeSetupSpec {
  readonly script: string;
  /** Keys the main checkout's recorded answer in `ctx.setupTreeRecords`. */
  readonly repositoryId: RepositoryId;
  readonly policy: DirtyTreePolicy;
}

/**
 * Run the repo's `setupScript` inside the freshly-created worktree, before the per-task subchain.
 * A git worktree is a bare checkout: `node_modules`, `target/`, `.venv`, build caches — none of it
 * is present (those paths are git-ignored and not copied). The per-task `verifyScript` runs pre-
 * AND post-task in THIS worktree, so without a per-worktree setup it would fail as
 * `baseline-broken` / `regressed` and block legitimate work. The prologue's once-per-repo setup
 * preps the MAIN repo, not these throwaway worktrees, so it cannot cover this.
 *
 * The script is bracketed by a working-tree check (`beginWorktreeSetupTreeCheck`): anything it
 * writes that git doesn't ignore would otherwise be swept into the task commit by `git add -A`.
 * What the operator already saw in the main checkout is discarded here; anything else blocks the
 * task (or, under policy `continue`, stays with a warning). The main checkout itself is never read
 * — sibling folds change it mid-wave — only its recorded answer on `ctx.setupTreeRecords`.
 *
 * Returns `undefined` when there is no setup script, or it succeeded and the check let the task
 * through (the caller proceeds to the body). Otherwise it BLOCKS only this task and returns a
 * narrowed `Result.ok` carrying the blocked task — on a non-zero exit, timeout or spawn error, a
 * refused change, or a git status that can't be read — siblings run in their own worktrees and are
 * untouched, and the wave is NEVER hard-aborted (unlike the prologue's main-repo setup gate, whose
 * hard-abort semantics are wrong for one isolated worktree). A user abort that races the setup
 * propagates verbatim, never a block.
 */
export const runWorktreeSetupScript = async (
  deps: BuildWaveBranchesDeps,
  worktreePath: AbsolutePath,
  setup: WorktreeSetupSpec | undefined,
  taskId: TaskId,
  ctx: ImplementCtx,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined,
  onStart: OnStart | undefined
): Promise<ElementResult<ImplementCtx> | undefined> => {
  if (setup === undefined) return undefined;
  const name = `worktree-setup-script-${String(taskId)}`;
  const aborted = (): boolean => signal?.aborted === true;
  // Don't burn an install while the user is already aborting.
  if (aborted()) return abortedStep(name, 0, onTrace);
  onStart?.({ elementName: name });

  const start = performance.now();
  const elapsed = (): number => performance.now() - start;
  const blockTask = (reason: string): ElementResult<ImplementCtx> =>
    blockTaskInWorktree(deps, ctx, taskId, name, elapsed(), reason, onTrace);
  const settleTree = await beginWorktreeSetupTreeCheck(deps.implement, {
    cwd: worktreePath,
    command: setup.script,
    policy: setup.policy,
    record: ctx.setupTreeRecords?.get(setup.repositoryId),
  });
  if (!settleTree.ok) {
    return blockTask(
      `worktree setup script not run — could not read the worktree's git status: ${settleTree.error.message}`
    );
  }
  const failure = await spawnWorktreeSetup(deps, worktreePath, setup.script, signal);
  // A user abort surfaces as the runner's AbortError (signal threaded into the spawn) — and may also
  // race the setup's natural failure — so check the signal before treating anything as a real outcome.
  if (aborted()) return abortedStep(name, elapsed(), onTrace);
  if (failure !== undefined) return blockTask(failure);
  const verdict = await settleTree.value();
  if (aborted()) return abortedStep(name, elapsed(), onTrace);
  if (verdict.kind === 'block') return blockTask(verdict.reason);
  onTrace?.({ elementName: name, status: 'completed', durationMs: elapsed() });
  return undefined;
};

/** Spawn the worktree's setup script. Returns the block reason when it didn't pass, else `undefined`. */
const spawnWorktreeSetup = async (
  deps: BuildWaveBranchesDeps,
  worktreePath: AbsolutePath,
  script: string,
  signal: AbortSignal | undefined
): Promise<string | undefined> => {
  // Thread the chain abort signal into the runner so a Ctrl-C mid-setup kills the child promptly
  // instead of waiting out the shell timeout while the wave holds its worktree.
  const ran = await deps.implement.shellScriptRunner.run(worktreePath, script, signal !== undefined ? { signal } : {});
  if (ran.ok && ran.value.passed) return undefined;
  const detail = ran.ok ? `exit ${String(ran.value.exitCode ?? 'null')}` : ran.error.message;
  return `worktree setup script failed (${detail}) — the task could not be prepared in its isolated worktree`;
};

/**
 * Block THIS task after its per-worktree setup failed or its working-tree check refused, and
 * narrow the ctx to it. Setup runs before the subchain, so the task is still `todo`/`in_progress` —
 * `markTaskBlocked` (which accepts only those states) is the clean domain transition (no
 * hand-projection like `worktree-fold.ts`'s `blockTaskForFoldConflict`, which exists only because a
 * fold conflict re-blocks an already-`done` task). Returns `Result.ok` so the branch runner COMPLETES with the block in its ctx — `mergeImplementWave` overlays this
 * branch's OWNED task (see `ownedTask` / `implementBranchId`) and `captureDurableFold` records it
 * the same way, so the block survives even an abort of a sibling wave. The subchain never runs, so
 * this is the only place the operator is told about the block.
 */
const blockTaskInWorktree = (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  taskId: TaskId,
  name: string,
  durationMs: number,
  reason: string,
  onTrace: OnTrace | undefined
): ElementResult<ImplementCtx> => {
  deps.implement.logger.warn('worktree setup blocked the task', { taskId: String(taskId), reason });
  const entry: TraceEntry = { elementName: name, status: 'failed', durationMs };
  onTrace?.(entry);
  const task = ctx.tasks?.find((t) => t.id === taskId);
  // No task in ctx (shouldn't happen — the wave carries the full list), or the task isn't in a
  // blockable state: carry ctx through so the reducer leaves base untouched and it resets/re-runs.
  if (task === undefined) return Result.ok({ ctx, trace: [entry] });
  // A per-worktree setup block is an own-failure block — the task couldn't be prepared, which a
  // relaunch / operator fix must address; it never cascade-clears via upstream unblock. Classified
  // explicitly: the setup script / repo state in the fresh worktree is what needs fixing, not the
  // model.
  const blocked = markTaskBlocked(task, reason, 'own', {
    blockCause: 'worktree-setup-failure',
    faultSide: 'environment',
  });
  if (!blocked.ok) return Result.ok({ ctx, trace: [entry] });
  publishTaskBlocked(deps.eventBus, blocked.value, deps.implement.clock());
  // Narrow to THIS task only — belt-and-braces: the merge already reads only `ownedTask(branch.id,
  // ctx)`, so emitting siblings here can no longer clobber a concurrently-merged copy, but keeping
  // the ctx small costs nothing and matches the narrowing contract the branch body applies below.
  return Result.ok({ ctx: { ...ctx, tasks: [blocked.value] }, trace: [entry] });
};

/** Where one task's worktree lives, which ref it is checked out on, and where its journal is. */
export interface WorktreeTarget {
  readonly repoRoot: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly branchRef: string;
  readonly taskId: TaskId;
  readonly progressFile: AbsolutePath;
}

const staleRefTarget = (ctx: ImplementCtx, target: WorktreeTarget): StaleRefTarget => ({
  repoRoot: target.repoRoot,
  sprintId: ctx.sprintId,
  taskId: target.taskId,
  taskName: ctx.tasks?.find((t) => t.id === target.taskId)?.name ?? String(target.taskId),
  progressFile: target.progressFile,
});

const samePath = async (a: string, b: string): Promise<boolean> => {
  if (a === b) return true;
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return ra === rb;
};

/**
 * Why the registered worktree can't be adopted, or `undefined` when it can: only an interrupted
 * attempt resumes in it, on this task's ref. A worktree left on the legacy-shaped ref by an older
 * run is adopted by renaming that ref first — the fold and teardown only know `branchRef`.
 */
const adoptionBlocker = async (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  target: WorktreeTarget,
  registeredBranch: string | undefined
): Promise<string | undefined> => {
  const { repoRoot, worktreePath, branchRef, taskId } = target;
  const path = String(worktreePath);
  const interrupted = ctx.tasks?.find((t) => t.id === taskId)?.attempts.at(-1)?.status === 'running';
  const legacyRef = legacyGitWorktreeRef(String(ctx.sprintId), String(taskId));
  if (interrupted && registeredBranch === `refs/heads/${branchRef}`) return undefined;
  if (interrupted && registeredBranch === `refs/heads/${legacyRef}`) {
    // The failed `worktree add -b` already created `branchRef`; clear it before taking its name.
    const cleared = await settleStaleWorktreeRefs(deps, staleRefTarget(ctx, target), [branchRef], new Set());
    const renamed = cleared.ok
      ? await gitRenameBranch(deps.implement.gitRunner, repoRoot, legacyRef, branchRef)
      : cleared;
    if (renamed.ok) return undefined;
    return (
      `the interrupted attempt's worktree at ${path} is on ${legacyRef}, which could not be renamed to ` +
      `${branchRef} (${renamed.error.message}) — rename it by hand, then unblock the task`
    );
  }
  return (
    `a worktree from an earlier run is still at ${path} and there is no interrupted attempt to resume in it — ` +
    `inspect it, run \`git worktree remove --force ${path}\` in ${String(repoRoot)}, then unblock the task`
  );
};

/**
 * `worktree add` failed. When that is because this task's worktree from an earlier run is still
 * there, adopt it if the task has an interrupted attempt to resume in it (its work is in that
 * tree), else block the task with what to do — leaving it untouched used to wedge the task forever,
 * every launch failing the same `add`. Any other failure returns `undefined` (not ours to handle).
 */
const resolveStrandedWorktree = async (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  target: WorktreeTarget,
  name: string,
  durationMs: number,
  onTrace: OnTrace | undefined
): Promise<ElementResult<ImplementCtx> | 'adopted' | undefined> => {
  const { repoRoot, worktreePath, taskId } = target;
  const path = String(worktreePath);
  const listed = await gitWorktreeList(deps.implement.gitRunner, repoRoot);
  let registered: GitWorktreeEntry | undefined;
  for (const entry of listed.ok ? listed.value : []) {
    if (await samePath(entry.path, path)) registered = entry;
  }
  const blockTask = (reason: string): ElementResult<ImplementCtx> =>
    blockTaskInWorktree(deps, ctx, taskId, name, durationMs, reason, onTrace);
  if (registered === undefined) {
    const exists = await pathExists(path);
    if (!exists.ok || !exists.value) return undefined;
    return blockTask(
      `a leftover directory blocks this task's worktree at ${path} — inspect it, delete it, then unblock the task`
    );
  }
  const blocker = await adoptionBlocker(deps, ctx, target, registered.branch);
  if (blocker !== undefined) return blockTask(blocker);
  deps.implement.logger.info('adopting the interrupted attempt’s worktree', { taskId: String(taskId), path });
  onTrace?.({ elementName: name, status: 'completed', durationMs });
  return 'adopted';
};

/**
 * Create the worktree. Returns `undefined` on success or adoption (the subchain advances ctx), a
 * narrowed `Result.ok` when a stranded worktree blocks the task, or a failed {@link ElementResult}
 * on any other `worktree add` failure so the branch fails without materialising a worktree.
 */
export const setupWorktree = async (
  deps: BuildWaveBranchesDeps,
  ctx: ImplementCtx,
  target: WorktreeTarget,
  onTrace: OnTrace | undefined,
  onStart: OnStart | undefined
): Promise<ElementResult<ImplementCtx> | undefined> => {
  const { repoRoot, worktreePath, branchRef, taskId } = target;
  const gitRunner = deps.implement.gitRunner;
  const name = `worktree-setup-${String(taskId)}`;
  onStart?.({ elementName: name });
  const start = performance.now();
  // Prune defensively first: a crashed prior run can leave a stale `.git/worktrees/<name>` record
  // whose directory has vanished, which would make `worktree add` fail. Prune is idempotent.
  await gitWorktreePrune(gitRunner, repoRoot);
  // Clear a ref an earlier run left (teardown keeps it on a block or an unfinished fold; a crash can
  // leak it) — else `worktree add -b <same-ref>` fails with 'branch already exists'. A ref still
  // checked out in a worktree is left for `resolveStrandedWorktree` to adopt or block on. An
  // unreadable list fails the setup: `branch -m` renames a checked-out ref without complaint.
  const listed = await gitWorktreeList(gitRunner, repoRoot);
  const cleared = listed.ok
    ? await settleStaleWorktreeRefs(
        deps,
        staleRefTarget(ctx, target),
        [branchRef, legacyGitWorktreeRef(String(ctx.sprintId), String(taskId))],
        new Set(listed.value.flatMap((e) => (e.branch !== undefined ? [e.branch] : [])))
      )
    : Result.error(
        new StorageError({
          subCode: 'io',
          message: `could not list worktrees, so leftover refs were left alone — relaunch: ${listed.error.message}`,
          cause: listed.error,
        })
      );
  const added = cleared.ok ? await gitWorktreeAdd(gitRunner, repoRoot, worktreePath, branchRef) : cleared;
  const durationMs = performance.now() - start;
  if (!added.ok) {
    const stranded = cleared.ok
      ? await resolveStrandedWorktree(deps, ctx, target, name, durationMs, onTrace)
      : undefined;
    if (stranded === 'adopted') return undefined;
    if (stranded !== undefined) return stranded;
    const entry: TraceEntry = { elementName: name, status: 'failed', durationMs, error: added.error };
    onTrace?.(entry);
    return Result.error({ error: added.error, trace: [entry] });
  }
  onTrace?.({ elementName: name, status: 'completed', durationMs });
  return undefined;
};
