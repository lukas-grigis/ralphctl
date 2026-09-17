import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import {
  gitResetHard,
  gitStashList,
  gitStashPop,
  stashEntryMatchesMessage,
} from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { quarantineStashMessage } from '@src/application/flows/implement/leaves/quarantine-blocked-diff.ts';
import {
  type ReproductionArtifact,
  reproductionTestTampered,
} from '@src/application/flows/implement/leaves/reproduce.ts';

/**
 * Restore a previously quarantined blocked diff right before an attempt's first generator turn, so
 * the generator continues from prior AI work instead of starting from a clean tree.
 *
 * ## What this undoes
 *
 * When a task settles `blocked`, `quarantine-blocked-diff` stashes the AI's rejected diff under the
 * deterministic message `quarantineStashMessage(sprintId, taskId)` so the shared serial worktree is
 * clean for the next task. On a later retry of that same task there was nothing to resurrect that
 * work — the generator restarted from scratch, throwing away whatever the prior attempt produced.
 * This leaf pops that exact stash back into the tree before the generator runs, so the retry builds
 * on the prior diff plus the evaluator critique rather than from zero.
 *
 * ## After pre-task-verify, and only when a turn follows
 *
 * The attempt runs `start-attempt → pre-task-verify → restore-blocked-diff (guarded by
 * {@link restoreBeforeFirstTurn}) → gen-eval loop`. Both halves of that placement matter:
 *
 *  - The baseline measures HEAD, not HEAD plus previously rejected work. Restored before the
 *    baseline, a red rejected diff turned the baseline red, the retry's red post-verify was then
 *    attributed `baseline-broken` (which never blocks), and under the sprint's `proceed` amnesty
 *    that rejected work was committed on red.
 *  - A successful `git stash pop` DROPS the entry, so from the pop on the tree holds the only copy.
 *    A pre-verify block runs zero turns, and `isSettledBlocked` reads a zero-turn block as "no AI
 *    work here" — so a diff popped before that block was never quarantined again: the parallel
 *    teardown force-removed the worktree holding it, and the serial path left it in the shared
 *    tree for the next task to inherit. Behind the guard, a pre-verify block never touches the
 *    stash at all.
 *
 * The pre-verify short-circuits (carried green baseline, fresh setup) see the same pre-restore
 * tree, which is the tree they are meant to vouch for.
 *
 * ## Best-effort by design
 *
 * Restoration is a convenience, not a correctness requirement: a retry that starts without the prior
 * diff is always valid (that work stays recoverable via `git stash list` regardless). So EVERY
 * failure here — a stash list failure, a pop conflict — is logged and swallowed as `Result.ok`. The
 * only ctx write is dropping a reproduction whose test didn't come back (see below). A missing stash
 * is the common case (most attempts have no prior block to restore) and is a silent no-op that costs
 * one git call.
 * `AbortError` stays the one exception: the leaf framework checks `signal?.aborted` around the use
 * case, so a mid-run cancel surfaces as an `aborted` trace entry verbatim — this best-effort swallow
 * only ever catches the `StorageError` a git call returns.
 *
 * ## Only onto a clean tree
 *
 * Swallowing a failed pop is NOT the same as leaving the tree alone: git can change the tree and
 * still fail, so {@link undoFailedPop} resets it before the leaf returns. That reset can only be
 * limited to what the pop brought in if nothing else was in the tree, so the leaf pops ONLY onto a
 * tree it just probed clean. A tree can legitimately be dirty here: changes the operator chose to
 * keep at the preflight prompt, a setup script's output that isn't ignored, or artifacts the verify
 * script left behind that aren't ignored. None of that work sits in any stash. On a dirty tree, or
 * when the probe fails, the leaf leaves the quarantined diff where it is and logs its message, and
 * the retry starts from the tree as found. Popping anyway is not an option: git will happily apply a
 * stash onto unrelated changes and conflict on its own paths, and no undo could then separate the
 * half-merge from the work that was already there.
 *
 * The reproduce step's failing test is not on that list. On a first launch it is in the tree, but
 * there is no quarantined stash to pop. On a relaunch with one, the reproduce leaf writes nothing:
 * that test is part of the quarantined diff.
 *
 * ## The reproduction a relaunch reuses
 *
 * On such a relaunch `ctx.reproductionArtifact` is the reproduction an earlier launch validated,
 * and its test only reaches the tree through this pop. So once the matching stash was listed, and
 * whatever became of the pop (restored, left in the stash, or undone), the leaf re-checksums that
 * test. A match keeps the artifact. A mismatch is one of two things:
 *
 *  - The pop restored an edit to the test: the earlier launch changed it (weakened it, say) and
 *    blocked, and this launch continues that work. The artifact STAYS, so the evaluator re-runs the
 *    reproduction and gets the tamper note — that is the edit its check exists for.
 *  - The reproduction isn't in the tree: the file is missing or unreadable, or it is the committed
 *    copy because the pop didn't restore (dirty tree, failed probe, undone pop) or restored an entry
 *    that never touched it. The reproducer prefers adding its case to an existing test file, so a
 *    committed copy is common. The artifact is CLEARED rather than point the generator at a test
 *    that isn't there and have the evaluator report tampering the AI never did.
 *
 * With no matching stash, ctx is left alone: an edit to the test during this launch is the
 * evaluator's to flag, not this leaf's to hide.
 */
export interface RestoreBlockedDiffLeafDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

export interface RestoreBlockedDiffLeafOpts {
  /** The tree the retry runs against — where the prior blocked diff is restored. */
  readonly cwd: AbsolutePath;
}

interface RestoreBlockedDiffInput {
  readonly sprintId: SprintId;
  readonly reproductionArtifact: ReproductionArtifact | undefined;
}

interface RestoreBlockedDiffOutput {
  /** Clear `ctx.reproductionArtifact` — its test is not in the tree. */
  readonly dropReproduction: boolean;
}

const KEEP_CTX: RestoreBlockedDiffOutput = { dropReproduction: false };

/**
 * Porcelain lines for everything `reset --hard HEAD` + `clean -fd` could touch: staged, unstaged and
 * unmerged changes plus untracked files. An empty list means that undo has nothing of the tree's own
 * to destroy. Both flags override repo config that would otherwise make a tree look cleaner than the
 * undo treats it: `--untracked-files=normal` beats `status.showUntrackedFiles=no` (hidden untracked
 * files are still deleted by `clean -fd`), and `--ignore-submodules=none` beats a
 * `submodule.<name>.ignore` setting. `gitStatusPorcelain` already passes the first one itself; the
 * second is the one specific to guarding this undo.
 *
 * A raw `gitRunner.run`, like `work-product-fingerprint.ts`'s own reads, rather than a
 * `git-operations.ts` export: that module sits at its `max-lines` budget, and the submodule override
 * is this probe's concern alone. A non-zero exit surfaces as `Result.error` so "git is broken in this
 * tree" is never read as "clean".
 */
const treeChanges = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], DomainError>> => {
  const result = await runner.run(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (!result.ok) return Result.error(result.error);
  if (result.value.exitCode !== 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `git status failed: ${(result.value.stderr || result.value.stdout).trim()}`,
      })
    );
  }
  return Result.ok(result.value.stdout.split('\n').filter((line) => line.length > 0));
};

/**
 * Undo a FAILED `git stash pop`. A non-zero pop is not a no-op. On a content conflict git leaves the
 * `<<<<<<<`-marked merge in the working tree, and even a pop git reports as refused can apply part
 * of the stash first: an untracked-file collision still lands the tracked changes, and an
 * "overwritten" refusal still restores the untracked files. Either way git KEEPS the stash entry.
 * Returning from there without touching the tree hands the generator a half-merged tree to build on,
 * and lets `commit-task`'s `git add -A` commit conflict markers or half of the prior diff whenever
 * the verify gate doesn't catch them. A conflict is likely by construction: the stash was pushed
 * against the PRIOR attempt's tree and pops into one forked from a since-advanced sprint branch.
 *
 * The caller only pops onto a tree it probed clean a moment earlier, so any change the probe finds
 * now came from the pop. Nothing else writes to this tree meanwhile: the serial path runs one task
 * at a time, and each parallel worktree belongs to one task. `gitResetHard` (`reset --hard HEAD` +
 * `clean -fd`) is then an exact undo that can't reach work this leaf didn't put there. The clean
 * also drops the untracked files a `-u` stash restores. Ignored paths (`node_modules`, build caches)
 * are outside both commands, so a prepared worktree stays prepared. Nothing the pop brought in is
 * lost either: the stash entry is still there under the same message.
 *
 * A tree the probe finds clean needs no undo. When the probe itself fails there's no reset either:
 * the tree state is then unknown, and `reset --hard` is the more destructive guess.
 */
const undoFailedPop = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  log: Logger,
  taskId: TaskId,
  message: string,
  popError: string
): Promise<void> => {
  const changed = await treeChanges(runner, cwd);
  if (!changed.ok) {
    log.warn('stash pop failed and the tree probe failed — tree state unverified, diff still in the stash', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
      probeError: changed.error.message,
    });
    return;
  }
  if (changed.value.length === 0) {
    log.warn('stash pop failed without changing the tree — retry starts from the unchanged tree', {
      taskId: String(taskId),
      stashMessage: message,
      error: popError,
    });
    return;
  }
  const reset = await gitResetHard(runner, cwd);
  if (!reset.ok) {
    log.warn('stash pop failed and the tree reset failed — the tree may still hold what the pop applied', {
      taskId: String(taskId),
      stashMessage: message,
      changedPaths: changed.value.length,
      error: reset.error.message,
    });
    return;
  }
  log.warn('stash pop failed; tree reset to its clean pre-pop state, diff still in stash', {
    taskId: String(taskId),
    stashMessage: message,
    changedPaths: changed.value.length,
    error: popError,
  });
};

/**
 * Guard predicate for {@link restoreBlockedDiffLeaf}: restore only when no terminal exit is on ctx,
 * i.e. when pre-task-verify let the attempt through.
 *
 * The invariant it holds: a quarantined diff leaves the stash only when a generator turn is
 * guaranteed to follow. Both gen-eval loops (normal and best-of-N) enter on `lastExit ===
 * undefined` and run at least one turn (`Math.max(1, maxTurns)`), and each turn stamps
 * `genEvalTurn` on every non-error return — crashed and self-blocked exits included. So every
 * settled outcome after a pop either commits the diff (`commit-task`), stashes it for a granted
 * retry (`quarantine-retry-diff`), or blocks with `genEvalTurn ≥ 1`, which `isSettledBlocked`
 * quarantines again. An interrupted attempt (abort, error, throw) never settles; the parallel
 * worktree teardown re-stashes a restored diff nothing consumed before it removes the worktree.
 *
 * @public
 */
export const restoreBeforeFirstTurn = (ctx: ImplementCtx): boolean => ctx.lastExit === undefined;

/**
 * Pop the quarantined diff, but only onto a tree probed clean a moment earlier (see "Only onto a
 * clean tree" above). Every outcome is logged; none is an error. `true` only when the pop put the
 * diff in the tree.
 */
const popOntoCleanTree = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  log: Logger,
  taskId: TaskId,
  message: string
): Promise<boolean> => {
  const before = await treeChanges(runner, cwd);
  if (!before.ok) {
    log.warn('tree probe failed — prior blocked diff left in the stash, retry starts without it', {
      taskId: String(taskId),
      cwd: String(cwd),
      stashMessage: message,
      error: before.error.message,
    });
    return false;
  }
  if (before.value.length > 0) {
    log.warn('tree has uncommitted changes — prior blocked diff left in the stash, retry starts without it', {
      taskId: String(taskId),
      cwd: String(cwd),
      stashMessage: message,
      uncommittedPaths: before.value.length,
    });
    return false;
  }

  const popped = await gitStashPop(runner, cwd, message);
  if (!popped.ok) {
    // Best-effort, but never silent about the tree: whatever a failed pop applied is undone
    // before the retry proceeds (see `undoFailedPop`), and each outcome logs what happened.
    await undoFailedPop(runner, cwd, log, taskId, message, popped.error.message);
    return false;
  }
  if (popped.value.popped) {
    log.info('prior blocked diff restored from stash', { taskId: String(taskId), stashMessage: message });
  }
  return popped.value.popped;
};

/** Whether the file at `testPath` can be read — the same read the tamper checksum makes. */
const testFileReadable = (cwd: AbsolutePath, testPath: string): Promise<boolean> =>
  fs.readFile(join(String(cwd), testPath)).then(
    () => true,
    () => false
  );

/**
 * Whether the pop brought a change to `testPath`: the tree was clean right before it, so any change
 * `git status` reports for that one path came from the restored diff. `--untracked-files=all` lists
 * a new file itself even inside a new directory. A failed probe counts as "yes": the file is there
 * and differs, and keeping the artifact leaves the call to the evaluator's tamper check.
 */
const restoredDiffTouches = async (runner: GitRunner, cwd: AbsolutePath, testPath: string): Promise<boolean> => {
  const result = await runner.run(cwd, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    `:(literal)${testPath}`,
  ]);
  if (!result.ok || result.value.exitCode !== 0) return true;
  return result.value.stdout.trim().length > 0;
};

/**
 * Whether the reproduction on ctx has to go, because its test is not in the tree — see "The
 * reproduction a relaunch reuses" above. `restored` says whether the pop put the diff in the tree.
 */
const reproductionLeftBehind = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  artifact: ReproductionArtifact | undefined,
  restored: boolean,
  log: Logger,
  taskId: TaskId
): Promise<boolean> => {
  if (artifact === undefined || !(await reproductionTestTampered(cwd, artifact))) return false;
  const context = { taskId: String(taskId), testPath: artifact.testPath };
  const carried =
    restored &&
    (await testFileReadable(cwd, artifact.testPath)) &&
    (await restoredDiffTouches(runner, cwd, artifact.testPath));
  if (carried) {
    log.warn('restored reproduction test differs from what was validated — kept for the evaluator to check', context);
    return false;
  }
  log.warn('reproduction test is not in the tree — continuing without the reproduction', context);
  return true;
};

export const restoreBlockedDiffLeaf = (
  deps: RestoreBlockedDiffLeafDeps,
  opts: RestoreBlockedDiffLeafOpts,
  taskId: TaskId
): Element<ImplementCtx> =>
  leaf<ImplementCtx, RestoreBlockedDiffInput, RestoreBlockedDiffOutput>(`restore-blocked-diff-${String(taskId)}`, {
    useCase: {
      execute: async (input): Promise<Result<RestoreBlockedDiffOutput, DomainError>> => {
        const log = deps.logger.named('task.restore-blocked-diff');
        const message = quarantineStashMessage(input.sprintId, taskId);

        const stashes = await gitStashList(deps.gitRunner, opts.cwd);
        if (!stashes.ok) {
          log.warn('stash list failed — retry will start from a clean tree', {
            taskId: String(taskId),
            cwd: String(opts.cwd),
            error: stashes.error.message,
          });
          return Result.ok(KEEP_CTX);
        }
        // No prior quarantined block for this task — the common case (most attempts never
        // blocked). Matched via `stashEntryMatchesMessage` — real git renders the subject
        // `On <branch>: <message>`, never the bare message, so an exact-equality check here
        // would never match a real stash and this pre-check would always (wrongly) short-circuit.
        if (!stashes.value.some((entry) => stashEntryMatchesMessage(entry, message))) return Result.ok(KEEP_CTX);

        const restored = await popOntoCleanTree(deps.gitRunner, opts.cwd, log, taskId, message);
        const dropReproduction = await reproductionLeftBehind(
          deps.gitRunner,
          opts.cwd,
          input.reproductionArtifact,
          restored,
          log,
          taskId
        );
        return Result.ok({ dropReproduction });
      },
    },
    input: (ctx): RestoreBlockedDiffInput => ({
      sprintId: ctx.sprintId,
      reproductionArtifact: ctx.reproductionArtifact,
    }),
    output: (ctx, out) => (out.dropReproduction ? { ...ctx, reproductionArtifact: undefined } : ctx),
  });
