/**
 * `ApplyFeedbackUseCase` — apply user-provided feedback as a follow-up AI
 * session against a settled sprint.
 *
 * Single-responsibility: hand the AI a thin wrapper pointing at the
 * pre-rendered feedback prompt file, parse signals. The dirty-tree fence
 * after each iteration, post-feedback check gate, and per-repo fan-out
 * are chain-layer concerns and live in the feedback chain definition.
 * The loop terminator (empty submission) lives in the launching surface
 * (TUI execute view / `sprint feedback` CLI).
 *
 * Empty-feedback short-circuit: an empty (or whitespace-only) `feedbackText`
 * is treated as "user wants to exit the loop". This use case returns an
 * empty-signals envelope so the chain can decide to stop without the cost
 * of an AI spawn. The check happens in the chain leaf (before this use
 * case is called) so the use case stays focused on the spawn round-trip.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { SignalBusPort } from '@src/business/ports/signal-bus-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import { renderFileHandoffWrapper } from '@src/business/usecases/_shared/file-handoff-wrapper.ts';

export interface ApplyFeedbackInput {
  /** Sprint receiving feedback — typically `'active'` or just-completed. */
  readonly sprint: Sprint;
  /**
   * Absolute path to the feedback prompt file produced by the upstream
   * `render-prompt-to-file` leaf. Required — the wrapper the AI
   * receives points at this path.
   */
  readonly promptFilePath: string;
  readonly cwd: AbsolutePath;
  /**
   * Optional absolute path the AI session adapter writes a `session.md`
   * audit record to. Best-effort.
   */
  readonly sessionMdPath?: AbsolutePath;
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

    // The full feedback prompt is on disk at `input.promptFilePath`.
    // Hand the AI a thin wrapper pointing at it.
    const wrapper = renderFileHandoffWrapper(input.promptFilePath);

    log.info('applying feedback');

    const sessionResult = await this.ai.spawnHeadless(wrapper, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const { signals, diagnostics } = this.parser.parseWithDiagnostics(sessionResult.value.output, {
      now: IsoTimestamp.now(),
    });

    // Surface silently-dropped malformed AI output. Same contract as
    // ExecuteSingleTaskUseCase — log only (the bus event vocabulary is closed).
    for (const d of diagnostics) {
      log.warn('signal parse diagnostic', { kind: d.kind, sample: d.sample });
    }

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
