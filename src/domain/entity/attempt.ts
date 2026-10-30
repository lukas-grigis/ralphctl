import { Result } from '@src/domain/result.ts';
import type { CommitSha } from '@src/domain/value/commit-sha.ts';
import type { DiffStat } from '@src/domain/value/diff-stat.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { parseRequiredString } from '@src/domain/value/parsers/parse-required-string.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';

/** Evaluator verdict for an attempt. `malformed` (unparseable output) counts as `failed` for budget. */
export type EvaluationStatus = 'passed' | 'failed' | 'malformed';

/**
 * Presence-only proof that verification ran — powers the `DoneTask` invariant. Carries no AI prose:
 * retaining the spawn's stdout here once pinned it for the sprint's lifetime (an OOM). The audit
 * trail is the per-round `signals.json`.
 */
export type Verification = Record<string, never>;

/** Outcome of an evaluator run after the task settles. */
export interface Evaluation {
  readonly status: EvaluationStatus;
  /** Path (relative to the per-task workspace) of the rendered verdict file. */
  readonly file: string;
}

/**
 * Which plateau detector produced a `plateau` exit — audit instrumentation only. `threshold` is the
 * one live detector (`plateau-detection.ts`); `diversity` / `entropy` are retired, still parsed.
 */
export type PlateauSource = 'threshold' | 'diversity' | 'entropy';

/**
 * Structured warning on an attempt that settled `done` without a passed evaluation, or (`crashed`)
 * on a failed-and-retried attempt. Only a generator `<task-blocked>` blocks the task; every other
 * failure mode settles `done` with one of these so the operator can review.
 */
export type AttemptWarning =
  | { readonly kind: 'budget-exhausted'; readonly turnsUsed: number; readonly turnBudget: number }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[]; readonly source?: PlateauSource }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'verify-failed'; readonly exitCode: number | null; readonly stderr: string }
  | { readonly kind: 'crashed'; readonly detail: string };

/**
 * Why an attempt settled `aborted`. `user-cancel` and `harness-interrupted` (the next launch found it
 * still `running`) are free against `maxAttempts` — see {@link isFreeAttempt}. `process-crash` on old
 * records may also mean a leftover running attempt. `self-blocked`: the task blocked, nothing was
 * killed. `unknown`: legacy data.
 */
export type AbortCause =
  | 'user-cancel'
  | 'sigterm'
  | 'watchdog-killed'
  | 'rate-limit-exhausted'
  | 'process-crash'
  | 'harness-interrupted'
  | 'self-blocked'
  | 'unknown';

/**
 * Stamped on an attempt opened as a resume of an aborted one, so the TUI renders the resume banner
 * without walking history. `abortedAt` is the resume clock on cross-process resumes.
 */
export interface RecoveryContext {
  readonly fromAttemptN: number;
  readonly cause: AbortCause;
  readonly abortedAt: IsoTimestamp;
}

/** Outcome of one harness-side verify-script run. `skipped`: no verify script configured. */
export type VerifyRunOutcome = 'success' | 'failed' | 'spawn-error' | 'skipped';

/** Before (`pre`, the baseline) or after (`post`, authoritative) the generator turn. */
export type VerifyRunPhase = 'pre' | 'post';

/**
 * One harness-side verify-script run — the harness's own verdict, independent of the AI's
 * `task-verified` self-report. Full logs live at `<sprintDir>/logs/verify/<task-id>/<phase>-attempt-<N>.log`.
 */
export interface VerifyRun {
  readonly phase: VerifyRunPhase;
  /** When the harness recorded the outcome (not script start). */
  readonly ranAt: IsoTimestamp;
  /** Empty for `skipped`. */
  readonly command: string;
  /** `0` for success / skipped, `-1` for spawn-error. */
  readonly exitCode: number;
  /** `0` for skipped. Includes any confirm re-run. */
  readonly durationMs: number;
  readonly outcome: VerifyRunOutcome;
  /** First gate that failed, then passed the confirm re-run on the same tree; keeps a `'clean'` flake visible. */
  readonly flakyFailure?: { readonly command: string; readonly exitCode: number };
}

/** Pre → post verify outcome: green→green `clean`, green→red `regressed`, red→red `baseline-broken`, red→green `fixed-baseline`. */
export type Attribution = 'clean' | 'regressed' | 'baseline-broken' | 'fixed-baseline';

/** Why `restore-blocked-diff` left a quarantined diff in its stash although the operator wanted it back. */
export type PriorWorkNotRestoredReason =
  'dirty-tree' | 'tree-probe-failed' | 'pop-failed' | 'pop-failed-tree-unverified' | 'stash-list-failed';

/** What `restore-blocked-diff` did with the task's quarantined diff before the attempt's first turn. */
export type PriorWorkOutcome =
  | { readonly kind: 'restored'; readonly stashMessage: string; readonly stat?: DiffStat }
  | { readonly kind: 'kept-by-choice'; readonly stashMessage: string }
  | {
      readonly kind: 'not-restored';
      readonly stashMessage: string;
      readonly reason: PriorWorkNotRestoredReason;
      readonly uncommittedPaths?: number;
    };

interface AttemptBase {
  readonly n: number;
  readonly startedAt: IsoTimestamp;
  readonly verification?: Verification;
  readonly evaluation?: Evaluation;
  /** Free-form critique fed into the next iteration's prompt. */
  readonly critique?: string;
  readonly commitSha?: CommitSha;
  /** Generator session for resume: the resumed thread on a crash resume, then the last turn's session at settle. */
  readonly sessionId?: string;
  /** At most one per attempt — a later warning overwrites. */
  readonly warning?: AttemptWarning;
  /** Only on `aborted` attempts. */
  readonly abortCause?: AbortCause;
  /** POSIX signal name or exit code captured at abort time — forensic detail only. */
  readonly signalOrExitCode?: string | number;
  readonly recovering?: RecoveryContext;
  /** Append-only; at most one `pre` and one `post` row under the current flow. */
  readonly verifyRuns?: readonly VerifyRun[];
  /** Absent until post-verify runs, or when it can't be determined (pre spawn-error, skipped script). */
  readonly attribution?: Attribution;
  /** Pre-verify ran red before the AI got a turn, so a later red verdict may not be the AI's fault. */
  readonly baselineBroken?: boolean;
  /**
   * Raw provider-reported prompt tokens summed over the attempt's spawns. Absent — never `0` — when
   * no spawn reported usage: a fabricated zero is indistinguishable from a free attempt.
   */
  readonly inputTokens?: number;
  /** Completion-side mirror of {@link inputTokens}. */
  readonly outputTokens?: number;
  /** Wall-clock ms INSIDE AI spawns — deliberately not `finishedAt - startedAt`, which includes harness work. */
  readonly durationMs?: number;
  /** Restore outcome for the task's quarantined diff. Absent when there was nothing to restore. */
  readonly priorWork?: PriorWorkOutcome;
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

/** `running` → `verified` (needs `verification`) | `failed` | `malformed` | `aborted`; terminal states stamp `finishedAt`. */
export type Attempt = RunningAttempt | TerminalAttempt;

export interface StartAttemptInput {
  readonly n: number;
  readonly startedAt: IsoTimestamp;
  readonly sessionId?: string;
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

/** Raw cost telemetry for one attempt; only what a provider actually reported. */
export interface AttemptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs?: number;
}

const isCount = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Stamp usage field by field: a count the caller lacks stays ABSENT rather than a fabricated `0`. */
export const recordAttemptUsage = (att: RunningAttempt, usage: AttemptUsage): RunningAttempt => ({
  ...att,
  ...(isCount(usage.inputTokens) ? { inputTokens: usage.inputTokens } : {}),
  ...(isCount(usage.outputTokens) ? { outputTokens: usage.outputTokens } : {}),
  ...(isCount(usage.durationMs) ? { durationMs: usage.durationMs } : {}),
});

/** Why an attempt died, stamped only on the `aborted` transition. */
export interface AbortMetadata {
  readonly abortCause: AbortCause;
  readonly signalOrExitCode?: string | number;
}

/** Settle as `verified`; refuses an attempt with no recorded verification. */
export const verifyAttempt = (
  att: RunningAttempt,
  finishedAt: IsoTimestamp
): Result<VerifiedAttempt, InvalidStateError> => {
  if (att.verification === undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'attempt',
        currentState: 'running',
        attemptedAction: 'complete-as-verified',
        message: `cannot mark attempt n=${att.n} verified: no verification recorded`,
        hint: 'Call recordRunningAttemptVerification before completing as verified.',
      })
    );
  }
  return Result.ok({ ...att, status: 'verified', finishedAt, verification: att.verification });
};

/** Settle as `failed` / `malformed` / `aborted`. `abortMeta` is dropped on any status but `aborted`. */
export const completeAttempt = (
  att: RunningAttempt,
  status: FailedAttempt['status'],
  finishedAt: IsoTimestamp,
  abortMeta?: AbortMetadata
): FailedAttempt => {
  if (status === 'aborted' && abortMeta !== undefined) {
    return {
      ...att,
      status,
      finishedAt,
      abortCause: abortMeta.abortCause,
      ...(abortMeta.signalOrExitCode !== undefined ? { signalOrExitCode: abortMeta.signalOrExitCode } : {}),
    };
  }
  return { ...att, status, finishedAt };
};

/** Cut short by the harness or the operator, not the model: free against `maxAttempts` (streak-capped). */
export const isFreeAttempt = (att: Attempt): boolean =>
  att.status === 'aborted' && att.abortCause !== undefined && isFreeAbortCause(att.abortCause);

export const isFreeAbortCause = (cause: AbortCause): boolean =>
  cause === 'harness-interrupted' || cause === 'user-cancel';
