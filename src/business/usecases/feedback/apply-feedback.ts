/**
 * `ApplyFeedbackUseCase` — apply user-provided feedback as a follow-up AI
 * session against a settled sprint.
 *
 * Single-responsibility: build the feedback prompt, spawn the AI, parse
 * signals. The dirty-tree fence after each iteration, post-feedback check
 * gate, and per-repo fan-out are chain-layer concerns and live in the
 * feedback chain definition. The loop terminator (empty submission) lives
 * in the launching surface (TUI execute view / `sprint feedback` CLI).
 *
 * Empty-feedback short-circuit: an empty (or whitespace-only) `feedbackText`
 * is treated as "user wants to exit the loop". This use case returns an
 * empty-signals envelope so the chain can decide to stop without the cost
 * of an AI spawn.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';

export interface ApplyFeedbackInput {
  /** Sprint receiving feedback — typically `'active'` or just-completed. */
  readonly sprint: Sprint;
  /** Free-form user feedback. Empty / whitespace-only short-circuits. */
  readonly feedbackText: string;
  readonly cwd: AbsolutePath;
  readonly abortSignal?: AbortSignal;
}

export interface ApplyFeedbackOutput {
  /** Every harness signal parsed from the AI output, in emission order. */
  readonly signals: readonly HarnessSignal[];
  /** Raw AI stdout — kept for diagnostics / sidecar persistence. */
  readonly rawAiOutput: string;
}

export class ApplyFeedbackUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly parser: SignalParserPort,
    private readonly logger: LoggerPort,
    /**
     * Optional. When provided, every parsed harness signal is emitted on
     * the bus as `{ type: 'signal', signal, sprintId }` so the live
     * dashboard sees `<progress>`, `<note>`, `<task-verified>`, etc. in
     * real time during a feedback iteration.
     */
    private readonly signalBus?: SignalBusPort
  ) {}

  async execute(input: ApplyFeedbackInput): Promise<Result<ApplyFeedbackOutput, DomainError>> {
    const log = this.logger.child({ sprintId: input.sprint.id });

    if (input.feedbackText.trim().length === 0) {
      log.debug('feedback is empty — skipping AI spawn');
      return Result.ok({ signals: [], rawAiOutput: '' });
    }

    const promptResult = await this.prompts.buildFeedbackPrompt({
      sprint: input.sprint,
      feedbackText: input.feedbackText,
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info('applying feedback', { length: input.feedbackText.length });

    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const signals = this.parser.parse(sessionResult.value.output, {
      now: IsoTimestamp.now(),
    });

    // Live observability — same contract as ExecuteSingleTaskUseCase.
    if (this.signalBus !== undefined) {
      for (const signal of signals) {
        this.signalBus.emit({
          type: 'signal',
          signal,
          sprintId: input.sprint.id,
        });
      }
    }

    return Result.ok({
      signals,
      rawAiOutput: sessionResult.value.output,
    });
  }
}
