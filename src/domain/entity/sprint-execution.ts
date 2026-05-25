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
}

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
