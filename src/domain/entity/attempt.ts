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
 * passed evaluation but the task still settles as `done` (vs `blocked`), OR when an attempt is
 * failed-and-retried. The kinds:
 *
 *  - `budget-exhausted` — turn budget hit without the evaluator passing.
 *  - `plateau`          — two consecutive evals flagged the identical failed-dimension set.
 *  - `malformed`        — evaluator output couldn't be parsed (no verdict signal).
 *  - `verify-failed`    — post-task check script ran red after commit; non-fatal but surfaced.
 *  - `crashed`          — the AI process died (watchdog kill / spawn crash) before producing a
 *                         terminal verdict. Recorded on the failed attempt so the operator can
 *                         SEE the retry in attempt history + the progress journal (rather than the
 *                         task silently blocking after one attempt).
 *
 * Why warnings on a "done" task: the locked policy is that only `<task-blocked>` from the
 * generator → `markTaskBlocked`. Everything else (budget / plateau / malformed eval / red
 * verify) → `markTaskDone` with the structured warning attached so the operator can review. The
 * `crashed` kind is the exception in provenance — it rides a FAILED (retried) attempt, not a
 * done one — but shares the same audit purpose.
 */
export type AttemptWarning =
  | { readonly kind: 'budget-exhausted'; readonly turnsUsed: number; readonly turnBudget: number }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
  | { readonly kind: 'crashed'; readonly detail: string };

/**
 * Discriminated reason why an attempt was settled as `aborted`. Capture point varies:
 *
 *  - `user-cancel`          — caller invoked `runner.abort()` (Ctrl-C in the TUI / CLI).
 *  - `sigterm`              — host sent SIGTERM (e.g. external orchestrator killed the process).
 *  - `watchdog-killed`      — the idle-stdout watchdog SIGTERM'd a wedged AI child.
 *  - `rate-limit-exhausted` — provider 429 retries gave up after `harness.rateLimitRetries`.
 *  - `process-crash`        — the prior process exited without settling the attempt; inferred
 *                              on the next launch when start-attempt finds a leftover `running`
 *                              attempt. We can't tell from a fresh process what killed the
 *                              previous one (Ctrl-C and a v8 OOM both leave the same trace) —
 *                              `process-crash` is the conservative label.
 *  - `unknown`              — fallback for legacy task data written before this field existed.
 *
 * Stored alongside `signalOrExitCode` (POSIX signal name or numeric exit code, when known).
 * The TUI's resume-from-aborted banner reads both fields to render a one-line parenthetical
 * (`(SIGTERM)`, `(rate limit)`, etc.).
 */
export type AbortCause =
  'user-cancel' | 'sigterm' | 'watchdog-killed' | 'rate-limit-exhausted' | 'process-crash' | 'unknown';

/**
 * Context attached to a `RunningAttempt` when it was opened as a resume of a prior aborted
 * attempt — set at attempt-creation time so the TUI doesn't have to walk the `attempts` array
 * to discover the resume. Persisted with the attempt so the field survives into terminal state
 * (a resumed attempt that itself succeeds still tells the post-mortem reader that it was a
 * resume of attempt N-1).
 *
 *  - `fromAttemptN`  — the 1-indexed `n` of the prior attempt that was just settled as aborted.
 *  - `cause`         — best-known reason the prior attempt aborted.
 *  - `abortedAt`     — when the prior attempt's settle (in `failCurrentAttempt`) ran, which is
 *                      the same clock value as the new running attempt's `startedAt` for
 *                      in-process aborts. For cross-process resumes (the process-crash path)
 *                      it's the resume clock, which is the closest proxy we have.
 */
export interface RecoveryContext {
  readonly fromAttemptN: number;
  readonly cause: AbortCause;
  readonly abortedAt: IsoTimestamp;
}

/**
 * Lifecycle of a single generator–evaluator iteration:
 *
 *   start ─► running ─►   verified            ◄── markTaskDone consumes this
 *                    └─►  failed | malformed  ◄── failCurrentAttempt records this
 *                    └─►  aborted             ◄── harness gave up before settling
 *
 * Terminal states stamp `finishedAt`. `verified` additionally requires `verification` to be
 * present — the structural invariant that powers `DoneTask`.
 * @public
 */
export type AttemptStatus = 'running' | 'verified' | 'failed' | 'malformed' | 'aborted';

/** Outcome bucket for one harness-side verify-script attempt. Mirrors {@link SetupRunOutcome}. */
export type VerifyRunOutcome =
  /** Script ran and exited 0. */
  | 'success'
  /** Script spawned and ran but exited non-zero. */
  | 'failed'
  /** The shell could not spawn the command (ENOENT, EACCES, missing binary). `exitCode === -1`. */
  | 'spawn-error'
  /** Repository has no `verifyScript` configured. Recorded as explicit evidence of a deliberate no-op. */
  | 'skipped';

/**
 * Discriminates whether a {@link VerifyRun} was captured BEFORE the AI generator turn
 * (the baseline-state snapshot) or AFTER it (the harness's authoritative verdict over the
 * AI's `task-verified` self-report).
 */
export type VerifyRunPhase = 'pre' | 'post';

/**
 * One structured row from the harness-side verify-script gate. Belt-and-braces independent
 * verification — the AI may emit a `task-verified` signal, but the harness re-runs the verify
 * script and records its own outcome here. Captured twice per attempt:
 *
 *   - `phase: 'pre'`  — before the generator turn. Captures the baseline state of the working
 *                       tree so a downstream red verdict can be attributed correctly (the AI's
 *                       work regressed a green baseline vs. landed on top of a pre-existing red).
 *   - `phase: 'post'` — after the generator commits. Authoritative: the harness's verdict
 *                       drives the task transition, NOT the AI's `task-verified` self-report.
 *
 * Schema deliberately mirrors `SetupRun`; both audit shapes carry structured metadata only.
 * The full untruncated stdout/stderr lives at
 * `<sprintDir>/logs/verify/<task-id>/{pre,post}-attempt-<N>.log` (per audit-[01]); readers
 * derive the path from `taskId + attemptN + phase` and lazy-load via the `LogTailReader` port.
 */
export interface VerifyRun {
  readonly phase: VerifyRunPhase;
  /** Wall-clock time at which the harness *recorded* the outcome (not script start). */
  readonly ranAt: IsoTimestamp;
  /** Verbatim shell command the harness invoked. Empty string for `outcome: 'skipped'`. */
  readonly command: string;
  /**
   * Process exit code. `0` for `'success'` / `'skipped'`. Non-zero for `'failed'`. `-1` for
   * `'spawn-error'`.
   */
  readonly exitCode: number;
  /** Total wall-clock duration in ms. `0` for `'skipped'`. */
  readonly durationMs: number;
  readonly outcome: VerifyRunOutcome;
}

/**
 * Attribution verdict for one attempt, derived from the pre/post verify-script outcomes:
 *
 *  - `clean`            — pre=green, post=green. The AI's work landed cleanly.
 *  - `regressed`        — pre=green, post=red. The AI broke the baseline; blame this attempt.
 *  - `baseline-broken`  — pre=red, post=red. Pre-existing failure; don't blame the AI.
 *  - `fixed-baseline`   — pre=red, post=green. The AI repaired a pre-existing failure.
 *
 * Absent when attribution can't be determined (e.g. pre-check spawn-error, or check-script
 * skipped entirely). The TUI baseline-health card aggregates these counts per sprint.
 */
export type Attribution = 'clean' | 'regressed' | 'baseline-broken' | 'fixed-baseline';

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
  /**
   * Reason this attempt was aborted. Meaningful only when `status === 'aborted'`; on
   * verified / failed / malformed / running attempts the field is absent. Optional because
   * legacy attempt records persisted before this field existed (see {@link AbortCause}).
   */
  readonly abortCause?: AbortCause;
  /**
   * Originating signal (POSIX name like `'SIGTERM'`) or numeric exit code captured at abort
   * time. Audit detail only — the TUI's parenthetical reads {@link abortCause} for the
   * label and uses this field for forensic chain.log reading.
   */
  readonly signalOrExitCode?: string | number;
  /**
   * Set at attempt creation when this attempt is opening as a resume of a prior aborted
   * attempt. Absent on the first attempt of a task and on subsequent attempts that weren't
   * preceded by an abort. See {@link RecoveryContext}.
   */
  readonly recovering?: RecoveryContext;
  /**
   * Append-only audit of every harness-side verify-script run for this attempt. At most one
   * `phase: 'pre'` row (taken before the generator turn) and one `phase: 'post'` row (after
   * the AI commits) per attempt under the current flow; the array shape is forward-compatible
   * with future per-round verify runs. See {@link VerifyRun}.
   */
  readonly verifyRuns?: readonly VerifyRun[];
  /**
   * Attribution verdict derived by post-task-verify from the pre/post outcomes. Absent until
   * the post-verify leaf runs, or when attribution can't be determined (pre-verify spawn-error,
   * skipped script). See {@link Attribution}.
   */
  readonly attribution?: Attribution;
  /**
   * Warning flag set by pre-task-verify when the working-tree baseline was already red before
   * the AI got a chance to run. Surfaced in the TUI so operators know a downstream failure
   * may not be the AI's fault.
   */
  readonly baselineBroken?: boolean;
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
  /**
   * Pre-derived recovery context. Supplied by callers that opened this attempt as a resume
   * of a prior aborted attempt (e.g. `startAttemptUseCase` settling a leftover `running`
   * attempt before opening a new one). Absent on every other path.
   */
  readonly recovering?: RecoveryContext;
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
    ...(input.recovering !== undefined ? { recovering: input.recovering } : {}),
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
 * Optional metadata supplied when settling an attempt as `aborted`. Ignored for any other
 * terminal status. Stamped onto the attempt so future audit + the resume-from-aborted banner
 * can show *why* the attempt died, not just that it died.
 *
 *  - `abortCause`        — discriminated reason (see {@link AbortCause}).
 *  - `signalOrExitCode`  — POSIX signal name or numeric exit code, when known.
 */
export interface AbortMetadata {
  readonly abortCause: AbortCause;
  readonly signalOrExitCode?: string | number;
}

/**
 * Settle a running attempt. Transition into `verified` requires verification to be present —
 * the structural guarantee that a verified attempt carries the artifact that proved it.
 *
 * The optional `abortMeta` is consumed only on the `'aborted'` transition; passing it on any
 * other status is a no-op (silently dropped). Callers thread it through `failCurrentAttempt`
 * when settling a leftover running attempt during resume so the next attempt's
 * {@link RecoveryContext} can point at a fully-attributed prior.
 */
export const completeAttempt = (
  att: RunningAttempt,
  status: TerminalAttempt['status'],
  finishedAt: IsoTimestamp,
  abortMeta?: AbortMetadata
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
  if (status === 'aborted' && abortMeta !== undefined) {
    return Result.ok({
      ...att,
      status,
      finishedAt,
      abortCause: abortMeta.abortCause,
      ...(abortMeta.signalOrExitCode !== undefined ? { signalOrExitCode: abortMeta.signalOrExitCode } : {}),
    });
  }
  return Result.ok({ ...att, status, finishedAt });
};

/** True iff `att` is a {@link VerifiedAttempt}. Useful for narrowing without a switch. */
export const isVerifiedAttempt = (att: Attempt): att is VerifiedAttempt => att.status === 'verified';

// ───────────────────────── verify-run + attribution helpers ─────────────────────────

/**
 * Append a {@link VerifyRun} row to a running attempt's `verifyRuns` array. Pure structural
 * mutation — callers pass the result to {@link replaceLastAttempt} via the task-level
 * `appendAttemptVerifyRun` helper.
 */
export const appendVerifyRun = (att: RunningAttempt, run: VerifyRun): RunningAttempt => ({
  ...att,
  verifyRuns: [...(att.verifyRuns ?? []), run],
});

/** Stamp the {@link Attribution} verdict on a running attempt. */
export const setAttribution = (att: RunningAttempt, attribution: Attribution): RunningAttempt => ({
  ...att,
  attribution,
});

/** Mark the running attempt's baseline as broken (pre-check ran red before AI got a chance). */
export const markBaselineBroken = (att: RunningAttempt): RunningAttempt => ({
  ...att,
  baselineBroken: true,
});
