import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Run one round of `apply-feedback` against the AI. The use case is intentionally thin:
 * spawn the AI with a pre-built prompt, inspect the signals it produced, decide whether the
 * generator self-blocked, and return the structured outcome.
 *
 * Termination of the outer review loop is the chain's concern, not this use case's. The
 * use case returns whatever signals the AI emitted; the leaf decides what to do based on
 * `blockedReason` (halt review) or normal completion (continue).
 */
export interface ApplyFeedbackProps {
  /** Drive one AI call; leaf reads the provider's signalsFile and returns the parsed array. */
  readonly callApply: () => Promise<Result<readonly HarnessSignal[], DomainError>>;
  readonly logger: Logger;
}

export interface ApplyFeedbackOutput {
  readonly signals: readonly HarnessSignal[];
  readonly blockedReason?: string;
}

const findTaskBlocked = (signals: readonly HarnessSignal[]): string | undefined =>
  signals.find((s): s is HarnessSignal & { type: 'task-blocked' } => s.type === 'task-blocked')?.reason;

export const applyFeedbackUseCase = async (
  props: ApplyFeedbackProps
): Promise<Result<ApplyFeedbackOutput, DomainError>> => {
  const log = props.logger.named('feedback.apply');
  log.debug('applying feedback round');

  const signalsResult = await props.callApply();
  if (!signalsResult.ok) {
    log.error('apply-feedback AI call failed', { error: signalsResult.error.message });
    return Result.error(signalsResult.error);
  }
  const signals = signalsResult.value;
  const blockedReason = findTaskBlocked(signals);

  if (blockedReason !== undefined) {
    log.warn(`AI emitted <task-blocked>: ${blockedReason}`, { signalCount: signals.length, blockedReason });
  } else {
    log.info(`apply-feedback complete (${String(signals.length)} signal(s))`, { signalCount: signals.length });
  }

  return Result.ok({
    signals,
    ...(blockedReason !== undefined ? { blockedReason } : {}),
  });
};
