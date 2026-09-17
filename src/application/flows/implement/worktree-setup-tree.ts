import { Result } from '@src/domain/result.ts';
import { type SetupTreeRecord, setupTreeRecordCovers } from '@src/domain/entity/sprint-execution.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { DirtyTreePolicy } from '@src/business/task/preflight-task.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import {
  gitDiscardEntries,
  gitStatusSnapshot,
  porcelainEntryKey,
  porcelainEntryPaths,
  type PorcelainEntry,
} from '@src/integration/io/git-tree-snapshot.ts';
import { describePaths } from '@src/application/flows/implement/leaves/setup-tree-guard.ts';

/**
 * The working-tree check around a parallel task's per-worktree setup script — the worktree
 * counterpart of the main checkout's post-setup check (`leaves/setup-tree-guard.ts`).
 *
 * A task worktree is a fresh checkout of the sprint branch, and its task commit runs `git add -A`.
 * Whatever the setup script writes there that git doesn't ignore would ride along in that commit
 * and land on the sprint branch at fold time: a lockfile the operator stashed in the main checkout,
 * or one the operator kept there — which then also makes the fold itself fail, because the main
 * checkout holds the same change uncommitted. So each worktree's setup is bracketed by a status
 * snapshot, and what the script introduced is matched against the main checkout's recorded answer
 * (`SetupTreeRecord`, read off `ctx.setupTreeRecords` — never by re-reading the main checkout,
 * which sibling folds change mid-wave). See {@link worktreeSetupDirtAction} for the mapping.
 */

/** What to do with one entry a worktree's setup script introduced. */
export type WorktreeSetupDirtAction = 'discard' | 'keep' | 'block';

/**
 * The mapping, kept in one place:
 *
 *  - no recorded answer for the repo → `block` (nothing to match the change against);
 *  - every path of the entry was already seen in the main checkout → `discard` it in the worktree.
 *    The main checkout keeps its own copy for the operator (or already stashed / reset it); the
 *    task commit must not carry it, whatever main's outcome was. It goes right after setup, not at
 *    commit time: excluding the path from the commit would also drop the task's own change to it
 *    (a lockfile when the task adds a dependency). A build that needs the discarded output then
 *    fails verify in the worktree, which is why the discard is logged at warn;
 *  - an unseen path → `keep` under policy `continue` (the operator opted into proceeding on
 *    whatever is in the tree), otherwise `block` this task.
 *
 * A path counts as seen when {@link setupTreeRecordCovers} says so — a directory entry covers
 * everything under it. A truncated record is taken at its word: a path missing from it counts as
 * unseen.
 */
export const worktreeSetupDirtAction = (
  entry: PorcelainEntry,
  record: SetupTreeRecord | undefined,
  policy: DirtyTreePolicy
): WorktreeSetupDirtAction => {
  if (record === undefined) return 'block';
  if (porcelainEntryPaths(entry).every((path) => setupTreeRecordCovers(record, path))) return 'discard';
  return policy === 'continue' ? 'keep' : 'block';
};

/** The check's verdict: run the task, or block it with `reason`. */
export type WorktreeTreeVerdict = { readonly kind: 'proceed' } | { readonly kind: 'block'; readonly reason: string };

export interface WorktreeSetupTreeDeps {
  readonly gitRunner: GitRunner;
  readonly logger: Logger;
}

export interface WorktreeSetupTreeInput {
  /** The task's worktree. */
  readonly cwd: AbsolutePath;
  /** The setup command, for messages. */
  readonly command: string;
  readonly policy: DirtyTreePolicy;
  /** The main checkout's recorded answer for the task's repo, if any. */
  readonly record: SetupTreeRecord | undefined;
}

const PROCEED: WorktreeTreeVerdict = { kind: 'proceed' };
const block = (reason: string): WorktreeTreeVerdict => ({ kind: 'block', reason });

const SERIAL_HINT = 'run tasks one at a time (`concurrency.maxParallelTasks 1`)';
const FIX_HINT = `make the setup script leave a fresh checkout unchanged (a frozen-lockfile install, ignored generated output), or ${SERIAL_HINT}`;
const DISCARD_HINT = `A red verify in this worktree may trace back to this: if the build needs them, make the setup script write generated output to git-ignored paths, or ${SERIAL_HINT}`;

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;
const pathsOf = (entries: readonly PorcelainEntry[]): readonly string[] => entries.map((entry) => entry.path);
const changed = (entries: readonly PorcelainEntry[]): string =>
  `${plural(entries.length, 'path', 'paths')} (${describePaths(pathsOf(entries))})`;

/**
 * Snapshot the worktree right before its setup script spawns and return the function that settles
 * what the script changed once it exited green. A snapshot that fails is an error — the caller
 * blocks the task without spawning.
 */
export const beginWorktreeSetupTreeCheck = async (
  deps: WorktreeSetupTreeDeps,
  input: WorktreeSetupTreeInput
): Promise<Result<() => Promise<WorktreeTreeVerdict>, StorageError>> => {
  const before = await gitStatusSnapshot(deps.gitRunner, input.cwd);
  if (!before.ok) return Result.error(before.error);
  const beforeKeys = new Set(before.value.map(porcelainEntryKey));
  return Result.ok(() => settleWorktreeSetupTree(deps, input, beforeKeys));
};

const unreadable = (script: string, error: StorageError): WorktreeTreeVerdict =>
  block(
    `${script} ran, but the worktree's git status could not be read afterwards — refusing to treat it as clean: ${error.message}`
  );

const unseenReason = (
  script: string,
  record: SetupTreeRecord | undefined,
  unseen: readonly PorcelainEntry[]
): string => {
  if (record === undefined) {
    return `${script} changed ${changed(unseen)}, and the main checkout's setup has no recorded working-tree check to match them against — refusing to commit them unannounced. To fix: ${FIX_HINT}`;
  }
  const cut = record.seenPathsTruncated
    ? " (the main checkout's record is incomplete — it saw more top-level paths than it can list — so setup runs again on the next launch)"
    : '';
  return `${script} changed ${changed(unseen)} the main checkout's setup never showed${cut} — refusing to commit them unannounced. To fix: ${FIX_HINT}`;
};

const settleWorktreeSetupTree = async (
  deps: WorktreeSetupTreeDeps,
  input: WorktreeSetupTreeInput,
  beforeKeys: ReadonlySet<string>
): Promise<WorktreeTreeVerdict> => {
  const script = `worktree setup script \`${input.command}\``;
  const after = await gitStatusSnapshot(deps.gitRunner, input.cwd);
  if (!after.ok) return unreadable(script, after.error);
  const introduced = after.value.filter((entry) => !beforeKeys.has(porcelainEntryKey(entry)));
  if (introduced.length === 0) return PROCEED;

  const byAction = Object.groupBy(introduced, (entry) => worktreeSetupDirtAction(entry, input.record, input.policy));
  const { discard = [], keep = [], block: unseen = [] } = byAction;
  // Block before discarding anything: the worktree is removed with the blocked task anyway.
  if (unseen.length > 0) return block(unseenReason(script, input.record, unseen));

  const log = deps.logger.named('implement.worktree-setup-tree');
  if (discard.length > 0) {
    const allowed = new Set([...beforeKeys, ...keep.map(porcelainEntryKey)]);
    const failed = await discardSeen(deps, input, script, discard, allowed);
    if (failed !== undefined) return failed;
    log.warn(
      `discarded ${changed(discard)} that ${script} wrote in the task worktree — the main checkout already showed them, so the task commit must not carry them. ${DISCARD_HINT}`,
      { cwd: input.cwd, entries: pathsOf(discard) }
    );
  }
  if (keep.length > 0) {
    log.warn(
      `${script} changed ${changed(keep)} the main checkout's setup never showed — keeping them (policy=continue); the task commit will include them`,
      { cwd: input.cwd, entries: pathsOf(keep) }
    );
  }
  return PROCEED;
};

/**
 * Discard `entries`, then re-read the tree: anything that is neither pre-setup dirt nor a kept
 * entry must be gone. Returns the blocking verdict, or `undefined` when the discard took.
 */
const discardSeen = async (
  deps: WorktreeSetupTreeDeps,
  input: WorktreeSetupTreeInput,
  script: string,
  entries: readonly PorcelainEntry[],
  allowed: ReadonlySet<string>
): Promise<WorktreeTreeVerdict | undefined> => {
  const discarded = await gitDiscardEntries(deps.gitRunner, input.cwd, entries);
  if (!discarded.ok) {
    return block(
      `${script} changed ${changed(entries)} the main checkout already showed, and discarding them in the task worktree failed: ${discarded.error.message}`
    );
  }
  const reread = await gitStatusSnapshot(deps.gitRunner, input.cwd);
  if (!reread.ok) return unreadable(script, reread.error);
  const left = reread.value.filter((entry) => !allowed.has(porcelainEntryKey(entry)));
  if (left.length === 0) return undefined;
  return block(
    `${script} left ${changed(left)} in the task worktree that could not be discarded — refusing to commit them. To fix: ${FIX_HINT}`
  );
};
