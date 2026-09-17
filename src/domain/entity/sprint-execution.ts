import { Result } from '@src/domain/result.ts';
import type { Entity } from '@src/domain/entity/_base/entity.ts';
import type { HttpUrl } from '@src/domain/value/http-url.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { parseHttpUrl } from '@src/domain/value/parsers/parse-http-url.ts';
import { type ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Per-sprint execution record — pairs 1:1 with a `Sprint` via the shared `SprintId` (no
 * separate identity of its own). Carries delivery facts (branch, PR url) and audit data
 * (setup-script run history) that are orthogonal to sprint planning.
 *
 * Functions here are pure structural mutations with no own state machine. Use cases gate
 * calls on the partner Sprint's status (e.g., reject branch edits after `closeSprint`).
 */
export interface SprintExecution extends Entity<SprintId> {
  /** Same value as {@link Entity.id}. Retained for naming clarity at call sites. */
  readonly sprintId: SprintId;
  readonly branch: string | null;
  readonly pullRequestUrl: HttpUrl | null;
  /**
   * Structured audit of every harness-side setup-script attempt. Each implement chain run
   * appends one entry per affected repo — including the no-op rows produced when a repo has
   * no `setupScript` configured (`outcome: 'skipped'`). Earlier rows are preserved so an
   * operator can see how the environment was prepared across re-runs / resumes; this is the
   * data the baseline-health TUI card renders.
   *
   * Modeled as an array (not a Map) so it survives `JSON.stringify` losslessly; ordering is
   * insertion order — the most recent run wins on display when consumers dedupe by repo.
   */
  readonly setupRanAt: readonly SetupRun[];
  /**
   * One-time operator amnesty for a red `verifyScript` baseline. Set to `'proceed'` by the
   * `pre-task-verify` leaf when the operator picks "Proceed anyway" on the broken-baseline
   * prompt — subsequent tasks in the same sprint skip the prompt and run on the broken tree.
   * Cleared back to `undefined` on the next green pre-verify, so a baseline that goes red
   * again later in the sprint re-prompts (the policy is amnesty for ONE consecutive red
   * stretch, not a permanent override).
   */
  readonly baselineBrokenPolicy?: 'proceed';
}

/** Outcome bucket for one harness-side setup attempt. */
export type SetupRunOutcome =
  /** Script ran and exited 0 — or no script was configured (`outcome: 'skipped'` is preferred for the latter). */
  | 'success'
  /** Script spawned and ran but exited non-zero (script-level failure — gate failed cleanly). */
  | 'failed'
  /** The shell could not spawn the command (ENOENT, EACCES, missing binary). `exitCode === -1`. */
  | 'spawn-error'
  /** Repository has no `setupScript` configured. Recorded as explicit evidence of a deliberate no-op. */
  | 'skipped';

/**
 * One entry in {@link SprintExecution.setupRanAt} — full structured row for a single
 * setup-script attempt against a single repository.
 *
 * The audit row carries structured metadata only — exit code, duration, outcome. The full
 * untruncated stdout/stderr body lives at `<sprintDir>/logs/setup/<repository-id>.log`
 * (per audit-[01]); readers derive the path from `repositoryId` and lazy-load via the
 * `LogTailReader` port when an operator hovers / expands the row.
 */
export interface SetupRun {
  readonly repositoryId: RepositoryId;
  /** Wall-clock time at which the harness *recorded* the outcome (not script start). */
  readonly ranAt: IsoTimestamp;
  /** Verbatim shell command the harness invoked. Empty string for `outcome: 'skipped'`. */
  readonly command: string;
  /**
   * Process exit code. `0` for `'success'` / `'skipped'`. Non-zero for `'failed'`. `-1` for
   * `'spawn-error'` (no real exit code since the child never ran). May be `null` only when a
   * timeout or output-cap kill produced no code; in that case `outcome` is `'failed'`.
   */
  readonly exitCode: number;
  /** Total wall-clock duration in ms. `0` for `'skipped'`. */
  readonly durationMs: number;
  readonly outcome: SetupRunOutcome;
  /**
   * What the post-setup working-tree check settled for this run. Present only on a `'success'`
   * row whose check completed. Absent on failed / skipped rows, on rows written before the check
   * recorded anything, and when the check errored or the operator dismissed its menu — an absent
   * (or truncated) record makes the next launch run setup again instead of resume-skipping it.
   */
  readonly tree?: SetupTreeRecord;
}

/** How the post-setup working-tree check settled what a setup script changed. */
export type SetupTreeOutcome =
  /** The script introduced no working-tree entry. */
  | 'unchanged'
  /** The script's changes stayed in the tree — the operator chose Keep, or the policy is `continue`. */
  | 'kept'
  /** The operator stashed the tree. */
  | 'stashed'
  /** The operator reset the tree. */
  | 'reset';

/**
 * The durable answer of a repo's post-setup working-tree check. Parallel task worktrees run the
 * same setup script on a fresh checkout and match what it changes against `seenPaths`, without
 * re-reading the main checkout (sibling folds change it mid-wave).
 */
export interface SetupTreeRecord {
  readonly outcome: SetupTreeOutcome;
  /**
   * Repo-relative paths the operator has already seen: every entry that was in the tree right
   * before setup (dirt they kept at the dirty-tree menu, or that policy `continue` let through)
   * plus every entry the script introduced, whatever was then done with it. Entries the script
   * introduced come first. An entry ending in `/` stands for everything under that directory — an
   * untracked directory as git lists it, or a directory {@link recordSetupTree} collapsed paths
   * into to stay within {@link SETUP_TREE_SEEN_PATHS_MAX}. Read it through
   * {@link setupTreeRecordCovers}.
   */
  readonly seenPaths: readonly string[];
  /**
   * `true` when even collapsed to top-level directories the paths did not fit, so the list was cut
   * — a path missing from it may still have been seen. Such a record is never resumed from.
   */
  readonly seenPathsTruncated: boolean;
}

/** Upper bound on {@link SetupTreeRecord.seenPaths}, so a huge dirty tree can't bloat `execution.json`. */
export const SETUP_TREE_SEEN_PATHS_MAX = 200;

/** `path` is on the record, or sits under one of its `/`-terminated directory entries. */
export const setupTreeRecordCovers = (record: SetupTreeRecord, path: string): boolean =>
  record.seenPaths.some((seen) => seen === path || (seen.endsWith('/') && path.startsWith(seen)));

/**
 * Build a {@link SetupTreeRecord}: de-duplicates `seenPaths` keeping first occurrences in order.
 * A list longer than {@link SETUP_TREE_SEEN_PATHS_MAX} is collapsed into directory entries rather
 * than cut, so every path stays covered — see {@link collapseSeenPaths}. Only a list that doesn't fit
 * even then is cut, and flagged.
 */
export const recordSetupTree = (outcome: SetupTreeOutcome, seenPaths: readonly string[]): SetupTreeRecord => {
  const unique = [...new Set(seenPaths)];
  if (unique.length <= SETUP_TREE_SEEN_PATHS_MAX) return { outcome, seenPaths: unique, seenPathsTruncated: false };
  const collapsed = collapseSeenPaths(unique, SETUP_TREE_SEEN_PATHS_MAX);
  return {
    outcome,
    seenPaths: collapsed.slice(0, SETUP_TREE_SEEN_PATHS_MAX),
    seenPathsTruncated: collapsed.length > SETUP_TREE_SEEN_PATHS_MAX,
  };
};

/**
 * The `/`-terminated directories holding `path`, outermost first — `a/b/c.ts` and the directory
 * entry `a/b/c/` both sit in `['a/', 'a/b/']`. A top-level entry sits in none.
 */
const ancestorsOf = (path: string): readonly string[] => {
  const parents = (path.endsWith('/') ? path.slice(0, -1) : path).split('/').slice(0, -1);
  return parents.map((_, i) => `${parents.slice(0, i + 1).join('/')}/`);
};

/** Drops duplicates and entries a directory entry already covers, keeping first positions. */
const withoutCovered = (paths: readonly string[]): readonly string[] => {
  const unique = [...new Set(paths)];
  const dirs = new Set(unique.filter((path) => path.endsWith('/')));
  return unique.filter((path) => !ancestorsOf(path).some((dir) => dirs.has(dir)));
};

/**
 * Replace paths with the directory that holds them until at most `max` entries remain, going no
 * coarser than it has to: the deepest directories are tried first, and at each depth the ones
 * holding the most entries go first, stopping as soon as the list fits. The result keeps the
 * input's order (a collapsed directory takes its first path's place) and may still exceed `max`
 * when there are more top-level entries than that.
 */
const collapseSeenPaths = (paths: readonly string[], max: number): readonly string[] => {
  let current = withoutCovered(paths);
  const deepest = current.reduce((depth, path) => Math.max(depth, ancestorsOf(path).length), 0);
  for (let depth = deepest; depth >= 1 && current.length > max; depth -= 1) {
    current = collapseAtDepth(current, depth, max);
  }
  return current;
};

/**
 * One collapse pass: group the entries by the directory `depth` levels down that holds them, and
 * collapse the biggest groups until the list fits. A directory holding a single entry is never
 * collapsed — that would widen what counts as seen and save nothing.
 */
const collapseAtDepth = (paths: readonly string[], depth: number, max: number): readonly string[] => {
  const dirAt = (path: string): string | undefined => ancestorsOf(path)[depth - 1];
  const largestFirst = [...Map.groupBy(paths, dirAt)]
    .flatMap(([dir, members]) => (dir !== undefined && members.length > 1 ? [{ dir, saves: members.length - 1 }] : []))
    .sort((a, b) => b.saves - a.saves);
  const collapse = new Set<string>();
  let remaining = paths.length;
  for (const { dir, saves } of largestFirst) {
    if (remaining <= max) break;
    collapse.add(dir);
    remaining -= saves;
  }
  return withoutCovered(
    paths.map((path) => {
      const dir = dirAt(path);
      return dir !== undefined && collapse.has(dir) ? dir : path;
    })
  );
};

export interface SprintExecutionCreateInput {
  readonly sprintId: SprintId;
}

export const createSprintExecution = (input: SprintExecutionCreateInput): SprintExecution => ({
  id: input.sprintId,
  sprintId: input.sprintId,
  branch: null,
  pullRequestUrl: null,
  setupRanAt: [],
});

export const setExecutionBranch = (execution: SprintExecution, branch: string): SprintExecution => ({
  ...execution,
  branch,
});

export const recordExecutionPullRequestUrl = (
  execution: SprintExecution,
  url: string
): Result<SprintExecution, ValidationError> => {
  const parsed = parseHttpUrl('sprint-execution.pullRequestUrl', url);
  if (!parsed.ok) return Result.error(parsed.error);
  return Result.ok({ ...execution, pullRequestUrl: parsed.value });
};

/**
 * Append one structured setup-run row. Unlike the previous upsert-by-repo semantics, every
 * harness-side attempt is preserved — re-running implement produces a new entry rather than
 * overwriting the prior stamp. This is the audit trail the baseline-health TUI card and the
 * post-mortem `runs list` consume.
 */
export const appendExecutionSetupRun = (execution: SprintExecution, run: SetupRun): SprintExecution => ({
  ...execution,
  setupRanAt: [...execution.setupRanAt, run],
});

/**
 * Set (or clear) the one-time amnesty for a red verifyScript baseline. Pass `'proceed'` to
 * persist the operator's "continue on broken baseline" choice so the next task does not
 * re-prompt; pass `undefined` to clear the amnesty once the baseline turns green again (the
 * pre-task-verify leaf clears on green so a fresh red later in the sprint re-prompts).
 */
export const setExecutionBaselineBrokenPolicy = (
  execution: SprintExecution,
  policy: 'proceed' | undefined
): SprintExecution => {
  if (policy === undefined) {
    const { baselineBrokenPolicy: _omit, ...rest } = execution;
    void _omit;
    return rest;
  }
  return { ...execution, baselineBrokenPolicy: policy };
};
