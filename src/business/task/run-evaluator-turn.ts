import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { InProgressTask } from '@src/domain/entity/task.ts';
import {
  recordRunningAttemptCritique,
  recordRunningAttemptEvaluation,
  recordRunningAttemptWarning,
} from '@src/domain/entity/task-attempts.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import {
  computePlateauVerdict,
  type PlateauTurnRecord,
  type PlateauVerdict,
} from '@src/business/task/plateau-detection.ts';
import { isRecoverableTurnError } from '@src/business/task/turn-error-policy.ts';

/**
 * Run one evaluator turn of the gen-eval loop. Drives a single AI evaluate call, inspects the
 * harness signals it produced, records the evaluation outcome on the running attempt, and
 * decides whether the loop should continue (failed verdict + fresh critique) or exit
 * terminally (passed, malformed, or plateau).
 *
 * Decisions owned by this use case:
 *  - `callEvaluate` returned a recoverable error (the reviewer never produced a usable
 *     `signals.json` — wrong shape, wrong place, non-zero spawn exit) → `self-blocked` exit so
 *     the task settles as `blocked` (NOT `malformed`, which settle-attempt treats as done-with-
 *     warning and would mark an ungraded change `done`). Fatal errors (`Aborted`/`RateLimit`)
 *     propagate as `Result.error` to abort the whole run — see {@link isRecoverableTurnError}.
 *  - No evaluation signal at all → `malformed` exit.
 *  - `evaluation.status === 'passed'` → `passed` exit.
 *  - `evaluation.status === 'malformed'` → `malformed` exit.
 *  - `evaluation.status === 'failed'` + the plateau predicate fires with no exemption →
 *     `plateau` exit. The plateau predicate compares the current turn against `priorTurns`
 *     using `settings.harness.plateauThreshold` (default 3). It exempts turns where the
 *     failed-dimension count dropped, where the critique prose shifted against every prior
 *     turn in the window, or where the work-product fingerprint changed (the latter
 *     downgrades the plateau to a non-exiting warning, capped at two consecutive softenings).
 *  - Otherwise (`failed`, fresh dimensions or exemption applies) → continue: record critique
 *    on the running attempt so the next generator turn's prompt incorporates it; return no
 *    exit. When the reviewer left `critique` empty on a FAIL, a critique is synthesized from
 *    the failed dimensions' findings ({@link resolveCritique}) so the loop's only error wire
 *    to the next generator turn never goes silent.
 *
 * The actual AI call + signal extraction are integration concerns supplied as function-shape
 * deps. The leaf is responsible for reading the provider's `signalsFile`, forwarding signals
 * to the harness sink, and passing the parsed array here. The leaf also threads the per-turn
 * history (`priorTurns`) and the current generator's proposed commit subject through ctx so
 * the use case stays free of state.
 */
export type EvaluatorTurnExit =
  | { readonly kind: 'passed' }
  | { readonly kind: 'self-blocked'; readonly reason: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] };

export interface RunEvaluatorTurnProps {
  readonly task: InProgressTask;
  /**
   * Prior evaluator turns' records — used for plateau detection. Empty on the first turn;
   * appended-to by the evaluator leaf across the gen-eval loop. The newest entry is at the
   * end of the array.
   */
  readonly priorTurns?: readonly PlateauTurnRecord[];
  /**
   * Generator's `<commit-message>` subject from the same round (latest signal wins inside
   * the round). Threaded through so the plateau predicate's commit-progress exemption can
   * detect AI-side intent changes across turns even though the actual `git commit` runs
   * once per attempt, after the loop exits. Superseded by {@link changedFilesHash}; retained
   * only as the fallback proxy for records that carry no fingerprint.
   */
  readonly currentCommitSubject?: string;
  /**
   * Content fingerprint of the working tree's uncommitted changes for this round, computed by
   * the evaluator leaf via the git runner. The plateau predicate's work-product exemption only
   * softens to a warning when this fingerprint differs from every prior turn in the window — so
   * a reworded commit subject over an unchanged tree no longer evades the plateau. Absent when
   * the leaf could not run git (degrades to the commit-subject proxy).
   */
  readonly changedFilesHash?: string;
  /**
   * Threshold from `settings.harness.plateauThreshold` (2–5). Number of consecutive turns
   * flagging the same dimension set before the plateau exit fires. Predicate clamps
   * defensively so a misconfigured caller cannot crash the loop.
   */
  readonly plateauThreshold: number;
  /**
   * Drive one AI evaluate call. Returns the parsed signals (already extracted from
   * `provider.generate`'s signalsFile by the leaf) so this use case stays free of file I/O.
   */
  readonly callEvaluate: (task: InProgressTask) => Promise<Result<readonly HarnessSignal[], DomainError>>;
  /**
   * Path the evaluator's rendered verdict (`evaluation.md`) will land at, relative to the
   * per-task workspace. Stamped on the recorded `Evaluation` so the operator can navigate.
   */
  readonly evaluationFile: string;
  readonly logger: Logger;
}

export interface RunEvaluatorTurnOutput {
  readonly task: InProgressTask;
  /** Latest evaluation signal — caller stashes it to feed `priorTurns` on the next turn. */
  readonly evaluation?: EvaluationSignal;
  /** Terminal outcome; undefined means the loop should continue. */
  readonly exit?: EvaluatorTurnExit;
  /**
   * Newly-appended record from this turn. Leaf concatenates it to `ctx.plateauHistory` so
   * the next evaluator turn sees the full window. Undefined on `malformed`/no-signal paths
   * where the turn carried no usable evaluation.
   */
  readonly turnRecord?: PlateauTurnRecord;
}

const findEvaluation = (signals: readonly HarnessSignal[]): EvaluationSignal | undefined =>
  signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

/**
 * Resolve the critique fed forward to the next generator turn on a `failed` verdict.
 *
 * The evaluator's `critique` field is the loop's ONLY error wire to the next generator turn —
 * the per-dimension findings otherwise sit in the operator-only `evaluation.md` sidecar where
 * the generator never reads them. When the reviewer emits a FAIL but leaves `critique` empty
 * or absent, synthesize one from the failed dimensions' `finding` fields so the loop never
 * advances silently. `dimensionScoreSchema` guarantees a non-empty `finding` on every failed
 * dimension, so the synthesized critique always carries actionable content.
 *
 * Returns `undefined` only when the AI supplied no usable critique AND there are no failed
 * dimensions to synthesize from (a degenerate shape — `failed` with zero failures is already
 * rejected by the signal schema, so in practice the synthesized branch always fires).
 */
const resolveCritique = (evaluation: EvaluationSignal): string | undefined => {
  const explicit = evaluation.critique;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;

  const synthesized = evaluation.dimensions
    .filter((d) => !d.passed && d.finding.trim().length > 0)
    .map((d) => `[${d.dimension}] ${d.finding.trim()}`)
    .join('\n');
  return synthesized.length > 0 ? synthesized : undefined;
};

type TurnResult = Result<RunEvaluatorTurnOutput, DomainError>;

/**
 * Handle a `callEvaluate` failure. Fatal errors (user abort, rate-limit-after-retries) must
 * abort the whole run — propagate. Everything else is a recoverable signals-contract failure:
 * self-block THIS task so it settles as `blocked` (the generator's work is NOT committed/
 * marked-done ungraded — commit is gated on no block reason). Routing to `malformed` instead
 * would mark the change done.
 */
const handleEvaluateFailure = (err: DomainError, task: InProgressTask, log: Logger): TurnResult => {
  if (!isRecoverableTurnError(err)) {
    log.error('evaluate call failed (fatal — propagating)', { taskId: task.id, error: err.message });
    return Result.error(err);
  }
  log.warn('evaluator did not produce a valid signals.json — blocking task', {
    taskId: task.id,
    error: err.message,
  });
  return Result.ok({
    task,
    exit: { kind: 'self-blocked', reason: `evaluator did not produce a valid signals.json: ${err.message}` },
  });
};

/** `passed`/`malformed` are terminal exits recorded as-is; `undefined` means the loop continues. */
const handleTerminalStatus = (
  evaluation: EvaluationSignal,
  task: InProgressTask,
  log: Logger
): TurnResult | undefined => {
  if (evaluation.status === 'passed') {
    log.info('evaluator passed the attempt', { taskId: task.id });
    return Result.ok({ task, evaluation, exit: { kind: 'passed' } });
  }

  if (evaluation.status === 'malformed') {
    log.warn('evaluator emitted dimension scores but no terminal verdict', { taskId: task.id });
    return Result.ok({
      task,
      evaluation,
      exit: { kind: 'malformed', detail: 'evaluator emitted dimension scores but no terminal verdict' },
    });
  }

  return undefined;
};

/**
 * Build the current turn's plateau record from what we know NOW — the just-recorded
 * evaluation, the critique we're about to feed forward, and the generator's proposed
 * commit subject for this round.
 */
const buildTurnRecord = (
  evaluation: EvaluationSignal,
  critique: string | undefined,
  props: Pick<RunEvaluatorTurnProps, 'currentCommitSubject' | 'changedFilesHash'>
): PlateauTurnRecord => ({
  evaluation,
  ...(critique !== undefined && critique.trim().length > 0 ? { critique } : {}),
  ...(props.currentCommitSubject !== undefined && props.currentCommitSubject.trim().length > 0
    ? { commitSubject: props.currentCommitSubject }
    : {}),
  ...(props.changedFilesHash !== undefined && props.changedFilesHash.length > 0
    ? { changedFilesHash: props.changedFilesHash }
    : {}),
});

/**
 * `failed`, fresh dimensions or exemption applies → continue: record the critique on the
 * running attempt so the next generator turn's prompt incorporates it. `announce` gates the
 * trailing debug logs — the warning-softened caller (which already logged an `info` for the
 * softening) passes `false` to avoid double narration; the plain-continue path passes `true`.
 */
const finishContinuing = (
  task: InProgressTask,
  evaluation: EvaluationSignal,
  critique: string | undefined,
  turnRecord: PlateauTurnRecord,
  log: Logger,
  announce: boolean
): TurnResult => {
  if (critique !== undefined && critique.trim().length > 0) {
    const recordedCritique = recordRunningAttemptCritique(task, critique);
    if (!recordedCritique.ok) {
      log.error('cannot record critique on attempt', {
        taskId: task.id,
        error: recordedCritique.error.message,
      });
      return Result.error(recordedCritique.error);
    }
    if (announce) {
      log.debug('evaluator failed; recorded critique for next turn', { taskId: recordedCritique.value.id });
    }
    return Result.ok({ task: recordedCritique.value, evaluation, turnRecord });
  }

  if (announce) {
    log.debug('evaluator failed without critique; continuing', { taskId: task.id });
  }
  return Result.ok({ task, evaluation, turnRecord });
};

/**
 * Net stall, but the work-product fingerprint changed (real code edits) — record a `plateau`
 * warning so the attempt audit reflects the soft signal, then keep looping. Capped at
 * WARNING_SOFTEN_CAP consecutive softenings inside the predicate.
 */
const handleWarningVerdict = (
  verdict: Extract<PlateauVerdict, { kind: 'warning' }>,
  task: InProgressTask,
  critique: string | undefined,
  turnRecord: PlateauTurnRecord,
  evaluation: EvaluationSignal,
  log: Logger
): TurnResult => {
  const warned = recordRunningAttemptWarning(task, { kind: 'plateau', dimensions: verdict.dimensions });
  if (!warned.ok) {
    log.error('cannot record plateau warning on attempt', { taskId: task.id, error: warned.error.message });
    return Result.error(warned.error);
  }
  log.info('plateau softened to warning — work product changed; continuing', {
    taskId: warned.value.id,
    dimensions: verdict.dimensions,
    reason: verdict.reason,
  });
  // Continue: also record the critique so the next generator turn picks it up.
  return finishContinuing(warned.value, evaluation, critique, turnRecord, log, false);
};

export const runEvaluatorTurnUseCase = async (props: RunEvaluatorTurnProps): Promise<TurnResult> => {
  const log = props.logger.named('task.evaluator-turn');
  log.debug('running evaluator turn', { taskId: props.task.id });

  const signalsResult = await props.callEvaluate(props.task);
  if (!signalsResult.ok) return handleEvaluateFailure(signalsResult.error, props.task, log);
  const signals = signalsResult.value;

  const evaluation = findEvaluation(signals);
  if (evaluation === undefined) {
    log.warn('evaluator produced no `evaluation` signal in signals.json', {
      taskId: props.task.id,
    });
    return Result.ok({
      task: props.task,
      exit: { kind: 'malformed', detail: 'evaluator emitted no `evaluation` signal in signals.json' },
    });
  }

  const recorded = recordRunningAttemptEvaluation(props.task, {
    status: evaluation.status,
    file: props.evaluationFile,
  });
  if (!recorded.ok) {
    log.error('cannot record evaluation on attempt', { taskId: props.task.id, error: recorded.error.message });
    return Result.error(recorded.error);
  }

  const terminal = handleTerminalStatus(evaluation, recorded.value, log);
  if (terminal !== undefined) return terminal;

  // When the reviewer left `critique` empty on a FAIL we synthesize one from the per-dimension
  // findings so the wire to the next generator turn never goes silent (and so the plateau
  // predicate's critique-shift exemption has real text to compare instead of always falling
  // through on a missing critique).
  const critique = resolveCritique(evaluation);
  const baseRecord = buildTurnRecord(evaluation, critique, props);

  const verdict = computePlateauVerdict(props.priorTurns ?? [], baseRecord, {
    threshold: props.plateauThreshold,
  });

  // Stamp the assigned verdict kind onto the appended record so the warning cap is derivable
  // purely from history on the next turn — no counter threaded through ctx.
  const currentRecord: PlateauTurnRecord = { ...baseRecord, verdict: verdict.kind };

  if (verdict.kind === 'plateau') {
    log.warn('evaluator plateaued — no net progress across the window', {
      taskId: recorded.value.id,
      dimensions: verdict.dimensions,
      threshold: props.plateauThreshold,
    });
    return Result.ok({
      task: recorded.value,
      evaluation,
      exit: { kind: 'plateau', dimensions: verdict.dimensions },
      turnRecord: currentRecord,
    });
  }

  if (verdict.kind === 'warning') {
    return handleWarningVerdict(verdict, recorded.value, critique, currentRecord, evaluation, log);
  }

  if (verdict.kind === 'progress') {
    log.debug('plateau exempted — progress detected; continuing', {
      taskId: recorded.value.id,
      reason: verdict.reason,
    });
  }

  return finishContinuing(recorded.value, evaluation, critique, currentRecord, log, true);
};
