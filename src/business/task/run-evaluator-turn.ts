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
import { computePlateauVerdict, type PlateauTurnRecord } from '@src/business/task/plateau-detection.ts';
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
 *     using `settings.harness.plateauThreshold` (default 2). It exempts turns where a
 *     previously-failed dimension's score improved, where the critique prose shifted
 *     significantly, or where the AI's proposed commit message changed (the latter
 *     downgrades the plateau to a non-exiting warning recorded on the attempt).
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
   * once per attempt, after the loop exits.
   */
  readonly currentCommitSubject?: string;
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

export const runEvaluatorTurnUseCase = async (
  props: RunEvaluatorTurnProps
): Promise<Result<RunEvaluatorTurnOutput, DomainError>> => {
  const log = props.logger.named('task.evaluator-turn');
  log.debug('running evaluator turn', { taskId: props.task.id });

  const signalsResult = await props.callEvaluate(props.task);
  if (!signalsResult.ok) {
    const err = signalsResult.error;
    // Fatal errors (user abort, rate-limit-after-retries) must abort the whole run — propagate.
    // Everything else is a recoverable signals-contract failure: self-block THIS task so it
    // settles as `blocked` (the generator's work is NOT committed/marked-done ungraded — commit
    // is gated on no block reason). Routing to `malformed` instead would mark the change done.
    if (!isRecoverableTurnError(err)) {
      log.error('evaluate call failed (fatal — propagating)', { taskId: props.task.id, error: err.message });
      return Result.error(err);
    }
    log.warn('evaluator did not produce a valid signals.json — blocking task', {
      taskId: props.task.id,
      error: err.message,
    });
    return Result.ok({
      task: props.task,
      exit: { kind: 'self-blocked', reason: `evaluator did not produce a valid signals.json: ${err.message}` },
    });
  }
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

  if (evaluation.status === 'passed') {
    log.info('evaluator passed the attempt', { taskId: recorded.value.id });
    return Result.ok({ task: recorded.value, evaluation, exit: { kind: 'passed' } });
  }

  if (evaluation.status === 'malformed') {
    log.warn('evaluator emitted dimension scores but no terminal verdict', { taskId: recorded.value.id });
    return Result.ok({
      task: recorded.value,
      evaluation,
      exit: { kind: 'malformed', detail: 'evaluator emitted dimension scores but no terminal verdict' },
    });
  }

  // Build the current turn's plateau record from what we know NOW — the just-recorded
  // evaluation, the critique we're about to feed forward, and the generator's proposed
  // commit subject for this round. When the reviewer left `critique` empty on a FAIL we
  // synthesize one from the per-dimension findings so the wire to the next generator turn
  // never goes silent (and so the plateau predicate's critique-shift exemption has real text
  // to compare instead of always falling through on a missing critique).
  const critique = resolveCritique(evaluation);
  const currentRecord: PlateauTurnRecord = {
    evaluation,
    ...(critique !== undefined && critique.trim().length > 0 ? { critique } : {}),
    ...(props.currentCommitSubject !== undefined && props.currentCommitSubject.trim().length > 0
      ? { commitSubject: props.currentCommitSubject }
      : {}),
  };

  const verdict = computePlateauVerdict(props.priorTurns ?? [], currentRecord, {
    threshold: props.plateauThreshold,
  });

  if (verdict.kind === 'plateau') {
    log.warn('evaluator plateaued on the same failed dimensions', {
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
    // Same dimensions across threshold turns, but the AI's proposed commit subject changed —
    // record a `plateau` warning so the attempt audit reflects the soft signal, then keep
    // looping. The next evaluator turn decides whether the AI keeps making progress.
    const warned = recordRunningAttemptWarning(recorded.value, {
      kind: 'plateau',
      dimensions: verdict.dimensions,
    });
    if (!warned.ok) {
      log.error('cannot record plateau warning on attempt', {
        taskId: recorded.value.id,
        error: warned.error.message,
      });
      return Result.error(warned.error);
    }
    log.info('plateau softened to warning — commit-message changed; continuing', {
      taskId: warned.value.id,
      dimensions: verdict.dimensions,
      reason: verdict.reason,
    });
    // Continue: also record the critique so the next generator turn picks it up.
    if (critique !== undefined && critique.trim().length > 0) {
      const recordedCritique = recordRunningAttemptCritique(warned.value, critique);
      if (!recordedCritique.ok) {
        log.error('cannot record critique on attempt', {
          taskId: warned.value.id,
          error: recordedCritique.error.message,
        });
        return Result.error(recordedCritique.error);
      }
      return Result.ok({ task: recordedCritique.value, evaluation, turnRecord: currentRecord });
    }
    return Result.ok({ task: warned.value, evaluation, turnRecord: currentRecord });
  }

  if (verdict.kind === 'progress') {
    log.debug('plateau exempted — progress detected; continuing', {
      taskId: recorded.value.id,
      reason: verdict.reason,
    });
  }

  if (critique !== undefined && critique.trim().length > 0) {
    const recordedCritique = recordRunningAttemptCritique(recorded.value, critique);
    if (!recordedCritique.ok) {
      log.error('cannot record critique on attempt', {
        taskId: recorded.value.id,
        error: recordedCritique.error.message,
      });
      return Result.error(recordedCritique.error);
    }
    log.debug('evaluator failed; recorded critique for next turn', { taskId: recordedCritique.value.id });
    return Result.ok({ task: recordedCritique.value, evaluation, turnRecord: currentRecord });
  }

  log.debug('evaluator failed without critique; continuing', { taskId: recorded.value.id });
  return Result.ok({ task: recorded.value, evaluation, turnRecord: currentRecord });
};
