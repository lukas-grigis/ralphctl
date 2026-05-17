import { Result } from '@src/domain/result.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/**
 * Verdict the evaluator returned for an attempt's verification output.
 *  - `passed`    — verification ran clean; the attempt is a candidate for `markTaskDone`
 *  - `failed`    — verification ran but did not pass; harness loops with critique
 *  - `malformed` — evaluator could not parse output; treat as `failed` for budget purposes
 */
export type EvaluationStatus = 'passed' | 'failed' | 'malformed';

/**
 * Structural marker that proves verification ran on the attempt — its **presence** powers the
 * `DoneTask` invariant. Carries no AI prose: the body string was the source of a long-running
 * OOM (every retained `Verification.output` pinned the spawn's full stdout buffer for the
 * lifetime of the sprint). The signals file the provider wrote per-round lives at
 * `<sprintDir>/implement/<task-id>/rounds/<N>/generator/signals.json`; that's the audit trail.
 */
export type Verification = Record<string, never>;

/** Outcome of an evaluator run after the task settles. */
export interface Evaluation {
  readonly status: EvaluationStatus;
  /** Path (relative to the per-task workspace) of the rendered verdict file. */
  readonly file: string;
}

/**
 * Structured warning attached to an attempt when the gen-eval inner loop terminates without a
 * passed evaluation but the task still settles as `done` (vs `blocked`). The four kinds:
 *
 *  - `budget-exhausted` — turn budget hit without the evaluator passing.
 *  - `plateau`          — two consecutive evals flagged the identical failed-dimension set.
 *  - `malformed`        — evaluator output couldn't be parsed (no verdict signal).
 *  - `verify-failed`    — post-task check script ran red after commit; non-fatal but surfaced.
 *
 * Why warnings on a "done" task: the locked policy is that only `<task-blocked>` from the
 * generator → `markTaskBlocked`. Everything else (budget / plateau / malformed eval / red
 * verify) → `markTaskDone` with the structured warning attached so the operator can review.
 */
export type AttemptWarning =
  | { readonly kind: 'budget-exhausted'; readonly turnsUsed: number; readonly turnBudget: number }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string };

/**
 * Lifecycle of a single generator–evaluator iteration:
 *
 *   start ─► running ─►   verified            ◄── markTaskDone consumes this
 *                    └─►  failed | malformed  ◄── failCurrentAttempt records this
 *                    └─►  aborted             ◄── harness gave up before settling
 *
 * Terminal states stamp `finishedAt`. `verified` additionally requires `verification` to be
 * present — the structural invariant that powers `DoneTask`.
 */
export type AttemptStatus = 'running' | 'verified' | 'failed' | 'malformed' | 'aborted';

interface AttemptBase {
  readonly n: number;
  readonly startedAt: IsoTimestamp;
  readonly verification?: Verification;
  readonly evaluation?: Evaluation;
  /** Free-form critique fed into the next iteration's prompt. */
  readonly critique?: string;
  readonly commitSha?: CommitSha;
  /** Provider session id for replay / cost attribution. */
  readonly sessionId?: string;
  /**
   * Structured warning recorded when the inner loop terminates without a passed evaluation
   * but the task still settles as `done`. See {@link AttemptWarning}. Absent on the happy
   * path. At most one warning per attempt — later warnings overwrite earlier ones.
   */
  readonly warning?: AttemptWarning;
}

export interface RunningAttempt extends AttemptBase {
  readonly status: 'running';
  readonly finishedAt: null;
}

export interface VerifiedAttempt extends AttemptBase {
  readonly status: 'verified';
  readonly finishedAt: IsoTimestamp;
  /** Narrowed: a verified attempt structurally carries the proof. */
  readonly verification: Verification;
}

export interface FailedAttempt extends AttemptBase {
  readonly status: 'failed' | 'malformed' | 'aborted';
  readonly finishedAt: IsoTimestamp;
}

export type TerminalAttempt = VerifiedAttempt | FailedAttempt;
export type Attempt = RunningAttempt | TerminalAttempt;

export interface StartAttemptInput {
  readonly n: number;
  readonly startedAt: IsoTimestamp;
  readonly sessionId?: string;
}

export const startAttempt = (input: StartAttemptInput): Result<RunningAttempt, ValidationError> => {
  if (!Number.isInteger(input.n) || input.n < 1) {
    return Result.error(
      new ValidationError({
        field: 'attempt.n',
        value: input.n,
        message: 'attempt n must be a positive integer (1-indexed)',
      })
    );
  }
  let sessionId: string | undefined;
  if (input.sessionId !== undefined) {
    const parsed = parseRequiredString('attempt.sessionId', input.sessionId);
    if (!parsed.ok) return Result.error(parsed.error);
    sessionId = parsed.value;
  }
  return Result.ok({
    n: input.n,
    startedAt: input.startedAt,
    status: 'running',
    finishedAt: null,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
};

export const recordAttemptVerification = (att: RunningAttempt): RunningAttempt => ({
  ...att,
  verification: {},
});

export const recordAttemptEvaluation = (att: RunningAttempt, evaluation: Evaluation): RunningAttempt => ({
  ...att,
  evaluation,
});

export const recordAttemptCritique = (att: RunningAttempt, text: string): RunningAttempt => ({
  ...att,
  critique: text,
});

export const recordAttemptCommit = (att: RunningAttempt, sha: CommitSha): RunningAttempt => ({
  ...att,
  commitSha: sha,
});

export const recordAttemptWarning = (att: RunningAttempt, warning: AttemptWarning): RunningAttempt => ({
  ...att,
  warning,
});

/**
 * Settle a running attempt. Transition into `verified` requires verification to be present —
 * the structural guarantee that a verified attempt carries the artifact that proved it.
 */
export const completeAttempt = (
  att: RunningAttempt,
  status: TerminalAttempt['status'],
  finishedAt: IsoTimestamp
): Result<TerminalAttempt, InvalidStateError> => {
  if (status === 'verified') {
    if (att.verification === undefined) {
      return Result.error(
        new InvalidStateError({
          entity: 'attempt',
          currentState: 'running',
          attemptedAction: 'complete-as-verified',
          message: `cannot mark attempt n=${att.n} verified: no verification recorded`,
          hint: 'Call recordAttemptVerification before completing as verified.',
        })
      );
    }
    return Result.ok({ ...att, status: 'verified', finishedAt, verification: att.verification });
  }
  return Result.ok({ ...att, status, finishedAt });
};

/** True iff `att` is a {@link VerifiedAttempt}. Useful for narrowing without a switch. */
export const isVerifiedAttempt = (att: Attempt): att is VerifiedAttempt => att.status === 'verified';
