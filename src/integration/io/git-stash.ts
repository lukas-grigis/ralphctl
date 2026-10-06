import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import { runGitChecked, type GitRunner } from '@src/integration/io/git-runner.ts';
import { gitHasUncommittedChanges } from '@src/integration/io/git-operations.ts';

/**
 * Git stash operations. Every call that touches the stash stack goes through one in-process
 * mutex, which is why the whole family lives in this module: a caller resolving `stash@{N}`
 * outside it would reopen the index race the mutex closes.
 *
 * "Nothing to do" is `Result.ok` with a payload, not an error: `gitStashPush` returns
 * `{ stashed: false }` on a clean tree and `gitStashPop` returns `{ popped: false }` when no
 * entry matches.
 */

export interface StashOutcome {
  readonly stashed: boolean;
}

/** One row of `git stash show --numstat`. A binary file has no line counts, so both are 0. */
export interface StashFileStat {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly binary?: true;
}

/** What the stash holds under one message: how many entries, and the newest one's size. */
export interface StashInspection {
  readonly entries: number;
  readonly newest?: {
    readonly ref: string;
    readonly stat: DiffStat;
    readonly files: readonly StashFileStat[];
  };
}

/**
 * In-process FIFO mutex serialising every git-STASH operation (push / list / pop / inspect) that
 * flows through this module. `refs/stash` is ONE ref shared by a repo and every one of its linked
 * worktrees (only `HEAD` / bisect / per-worktree refs are private) — on the parallel implement
 * path several worktree branches push / list / pop concurrently against that SAME shared ref,
 * from within this ONE Node process. `gitStashPop` resolves its target by first LISTING the stack
 * and then acting on the matched POSITION in a SEPARATE git invocation; a sibling's concurrent
 * push in between those two calls shifts every later index by one, so an index resolved against a
 * now-stale listing can name a DIFFERENT (sibling's) entry — applying the wrong diff into the
 * wrong worktree, then dropping the sibling's still-unapplied one. Funnelling every stash call
 * through one queue makes each push/list/pop atomic with respect to the others: nothing else in
 * this process can touch the stack between one call's list and its own pop. Cross-PROCESS races
 * (an operator running `git stash` by hand mid-run) stay out of scope — only callers inside this
 * process are serialised, which is the concurrency the parallel implement path actually creates.
 */
const settled = (): undefined => undefined; // advances the mutex tail on settle, ok OR error
let stashMutexTail: Promise<unknown> = Promise.resolve();
const withStashMutex = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = stashMutexTail.then(fn, fn);
  stashMutexTail = result.then(settled, settled);
  return result;
};

/**
 * True when a `git stash list --format=%s` subject names the given deterministic stash message.
 * Real git renders the subject as `On <branch>: <message>` (or `On (no branch): <message>` on a
 * detached HEAD) — never the bare message — so this matches `": <message>"` as a subject suffix,
 * with bare equality kept for runners that surface the raw message verbatim (fakes, mainly).
 * Shared by {@link gitStashPop} and every caller that pre-checks existence so all agree on what
 * "this stash exists" means.
 * @public
 */
export const stashEntryMatchesMessage = (entry: string, message: string): boolean =>
  entry === message || entry.endsWith(`: ${message}`);

/** Un-mutexed core of {@link gitStashList} — used internally by {@link gitStashPop} so its own
 * list-then-pop sequence runs as ONE critical section instead of two separately-queued calls
 * (which would re-open the exact race the mutex exists to close). */
const listStashSubjects = async (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], StorageError>> => {
  const result = await runGitChecked(runner, cwd, ['stash', 'list', '--format=%s'], 'stash list');
  if (!result.ok) return Result.error(result.error);
  return Result.ok(result.value.stdout.split('\n').filter((line) => line.length > 0));
};

/**
 * Stash all uncommitted + untracked changes with a recoverable message. Returns
 * `{ stashed: false }` on a clean tree (callers treat it as a no-op).
 */
export const gitStashPush = (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<StashOutcome, StorageError>> =>
  withStashMutex(async () => {
    const dirty = await gitHasUncommittedChanges(runner, cwd);
    if (!dirty.ok) return Result.error(dirty.error);
    if (!dirty.value) return Result.ok({ stashed: false });

    const stash = await runGitChecked(runner, cwd, ['stash', 'push', '-u', '-m', message], 'stash push');
    if (!stash.ok) return Result.error(stash.error);
    return Result.ok({ stashed: true });
  });

/**
 * List stash entry subjects in the same order as `git stash list`. An empty stash yields
 * `Result.ok([])`. Bubbles a non-zero exit (e.g. not a git repo) as StorageError so callers
 * don't mistake a transport failure for an empty stash.
 */
export const gitStashList = (runner: GitRunner, cwd: AbsolutePath): Promise<Result<string[], StorageError>> =>
  withStashMutex(() => listStashSubjects(runner, cwd));

/**
 * Pop the first stash entry created by `git stash push -m <message>`, matched via
 * {@link stashEntryMatchesMessage} (real git never stores the message verbatim as the entry
 * subject — see that function). Returns `{ popped: false }` (a no-op) when no entry matches —
 * callers treat a missing stash as "nothing to restore", not an error.
 *
 * The list-then-pop sequence runs inside ONE `withStashMutex` critical section (via the internal
 * {@link listStashSubjects}, not the mutexed {@link gitStashList} — re-entering the same queue
 * from inside a queued call would deadlock it), so the index resolved here can never go stale:
 * nothing else in this process can push/pop between this call's list and its own pop. Without that,
 * a sibling branch's concurrent push shifts every later index by one, and popping a now-stale
 * position can apply a DIFFERENT task's diff into THIS worktree — silent cross-task contamination.
 */
export const gitStashPop = (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<{ readonly popped: boolean }, StorageError>> =>
  withStashMutex(async () => {
    const list = await listStashSubjects(runner, cwd);
    if (!list.ok) return Result.error(list.error);

    const index = list.value.findIndex((entry) => stashEntryMatchesMessage(entry, message));
    if (index === -1) return Result.ok({ popped: false });

    const pop = await runGitChecked(runner, cwd, ['stash', 'pop', `stash@{${String(index)}}`], 'stash pop');
    if (!pop.ok) return Result.error(pop.error);
    return Result.ok({ popped: true });
  });

const NUMSTAT_ROW_RE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

const parseNumstat = (stdout: string): StashFileStat[] =>
  stdout.split('\n').flatMap((line): StashFileStat[] => {
    const m = NUMSTAT_ROW_RE.exec(line);
    if (m === null) return [];
    const [, added = '-', deleted = '-', path = ''] = m;
    if (added === '-' || deleted === '-') return [{ path, insertions: 0, deletions: 0, binary: true }];
    return [{ path, insertions: Number(added), deletions: Number(deleted) }];
  });

const sumDiffStat = (files: readonly StashFileStat[], partial: boolean): DiffStat => {
  const base = {
    files: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
  return partial ? { ...base, partial: true } : base;
};

/** Numstat of one stash entry; when `--include-untracked` is rejected, the tracked-only stat marked partial. */
const showStashNumstat = async (
  runner: GitRunner,
  cwd: AbsolutePath,
  ref: string
): Promise<Result<{ readonly stat: DiffStat; readonly files: StashFileStat[] }, StorageError>> => {
  const full = await runGitChecked(
    runner,
    cwd,
    ['stash', 'show', '--numstat', '--include-untracked', ref],
    'stash show'
  );
  if (full.ok) {
    const files = parseNumstat(full.value.stdout);
    return Result.ok({ stat: sumDiffStat(files, false), files });
  }
  const tracked = await runGitChecked(runner, cwd, ['stash', 'show', '--numstat', ref], 'stash show');
  if (!tracked.ok) return Result.error(tracked.error);
  const files = parseNumstat(tracked.value.stdout);
  return Result.ok({ stat: sumDiffStat(files, true), files });
};

/**
 * Count the stash entries under `message` and measure the newest one, without touching the stack.
 * The ref is resolved and shown inside one mutex section so a sibling's push can't shift
 * `stash@{N}` onto another task's entry in between.
 */
export const gitStashInspect = (
  runner: GitRunner,
  cwd: AbsolutePath,
  message: string
): Promise<Result<StashInspection, StorageError>> =>
  withStashMutex(async () => {
    const list = await runGitChecked(runner, cwd, ['stash', 'list', '--format=%gd%x1f%s'], 'stash list');
    if (!list.ok) return Result.error(list.error);

    const refs = list.value.stdout
      .split('\n')
      .map((line) => line.split('\x1f'))
      .flatMap(([ref, subject]) =>
        ref !== undefined && subject !== undefined && stashEntryMatchesMessage(subject, message) ? [ref] : []
      );
    const [ref] = refs;
    if (ref === undefined) return Result.ok({ entries: 0 });

    const shown = await showStashNumstat(runner, cwd, ref);
    if (!shown.ok) return Result.error(shown.error);
    return Result.ok({ entries: refs.length, newest: { ref, ...shown.value } });
  });
