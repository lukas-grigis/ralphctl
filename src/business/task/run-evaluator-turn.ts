import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  type InProgressTask,
  recordRunningAttemptCritique,
  recordRunningAttemptEvaluation,
} from '@src/domain/entity/task.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { EvaluationSignal, HarnessSignal } from '@src/domain/signal.ts';
import { dimensionsEqual, failedDimensions } from '@src/business/task/plateau-detection.ts';

/**
 * Run one evaluator turn of the gen-eval loop. Drives a single AI evaluate call, inspects the
 * harness signals it produced, records the evaluation outcome on the running attempt, and
 * decides whether the loop should continue (failed verdict + fresh critique) or exit
 * terminally (passed, malformed, or plateau).
 *
 * Decisions owned by this use case:
 *  - No evaluation signal at all → `malformed` exit.
 *  - `evaluation.status === 'passed'` → `passed` exit.
 *  - `evaluation.status === 'malformed'` → `malformed` exit.
 *  - `evaluation.status === 'failed'` + same failed-dimension set as `priorEvaluation` →
 *     `plateau` exit (caller passes the prior turn's evaluation; the comparison is set-equality
 *     on dimension names, so paraphrased critiques don't unstick a true plateau).
 *  - Otherwise (`failed`, fresh dimensions) → continue: record critique on the running attempt
 *    so the next generator turn's prompt incorporates it; return no exit.
 *
 * The actual AI call + signal extraction are integration concerns supplied as function-shape
 * deps. The leaf is responsible for reading the provider's `signalsFile`, forwarding signals
 * to the harness sink, and passing the parsed array here.
 */
export type EvaluatorTurnExit =
  | { readonly kind: 'passed' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'plateau'; readonly dimensions: readonly string[] };

export interface RunEvaluatorTurnProps {
  readonly task: InProgressTask;
  /** Prior evaluator turn's evaluation (if any) — used for plateau detection. */
  readonly priorEvaluation?: EvaluationSignal;
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
  /** Latest evaluation signal — caller stashes it to feed `priorEvaluation` on the next turn. */
  readonly evaluation?: EvaluationSignal;
  /** Terminal outcome; undefined means the loop should continue. */
  readonly exit?: EvaluatorTurnExit;
}

const findEvaluation = (signals: readonly HarnessSignal[]): EvaluationSignal | undefined =>
  signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

export const runEvaluatorTurnUseCase = async (
  props: RunEvaluatorTurnProps
): Promise<Result<RunEvaluatorTurnOutput, DomainError>> => {
  const log = props.logger.named('task.evaluator-turn');
  log.debug('running evaluator turn', { taskId: props.task.id });

  const signalsResult = await props.callEvaluate(props.task);
  if (!signalsResult.ok) {
    log.error('evaluate call failed', { taskId: props.task.id, error: signalsResult.error.message });
    return Result.error(signalsResult.error);
  }
  const signals = signalsResult.value;

  const evaluation = findEvaluation(signals);
  if (evaluation === undefined) {
    log.warn('evaluator produced no <evaluation-passed> or <evaluation-failed> verdict', {
      taskId: props.task.id,
    });
    return Result.ok({
      task: props.task,
      exit: { kind: 'malformed', detail: 'evaluator emitted no <evaluation-passed> or <evaluation-failed> verdict' },
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

  if (props.priorEvaluation !== undefined && dimensionsEqual(props.priorEvaluation, evaluation)) {
    const dimensions = [...failedDimensions(evaluation)];
    log.warn('evaluator plateaued on the same failed dimensions', {
      taskId: recorded.value.id,
      dimensions,
    });
    return Result.ok({ task: recorded.value, evaluation, exit: { kind: 'plateau', dimensions } });
  }

  const critique = evaluation.critique;
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
    return Result.ok({ task: recordedCritique.value, evaluation });
  }

  log.debug('evaluator failed without critique; continuing', { taskId: recorded.value.id });
  return Result.ok({ task: recorded.value, evaluation });
};
