/**
 * `EvaluateTaskUseCase` — run a generator/evaluator code review on a
 * settled task. Spawns one autonomous AI session and parses the verdict.
 *
 * Single-responsibility: one evaluator round. The fix-and-re-evaluate loop
 * (with plateau detection, iterations cap, persisting the sidecar) is a
 * chain-layer concern — this use case takes optional `previousCritique`
 * context for re-evaluation rounds and returns a structured outcome.
 *
 * Malformed-output policy: if the parser finds no `EvaluationSignal`, this
 * use case synthesises one with `status: 'malformed'`, empty dimensions,
 * and the first 500 chars of the raw output as `critique`. The chain layer
 * persists the full text to the sidecar file. The evaluator never blocks
 * a task — task always proceeds to `done`, even on `failed` / `malformed`.
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { Result } from '../../../domain/result.ts';
import type { EvaluationSignal } from '../../../domain/signals/harness-signal.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '../../ports/ai-session-port.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import type { PromptBuilderPort } from '../../ports/prompt-builder-port.ts';
import type { SignalParserPort } from '../../ports/signal-parser-port.ts';

/** Possible outcomes of one evaluator round. */
export type EvaluationOutcome = 'passed' | 'failed' | 'malformed';

export interface EvaluateTaskInput {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly cwd: AbsolutePath;
  /**
   * Critique from the prior evaluator round. Threaded through to the
   * prompt builder so the evaluator can grade against the previous
   * verdict on re-evaluation rounds.
   */
  readonly previousCritique?: string;
  readonly abortSignal?: AbortSignal;
}

export interface EvaluateTaskOutput {
  readonly outcome: EvaluationOutcome;
  /** The evaluation signal — synthesised as malformed when none was emitted. */
  readonly signal: EvaluationSignal;
  /** Raw evaluator stdout — chain persists this to `evaluations/<taskId>.md`. */
  readonly fullCritique: string;
}

const MAX_MALFORMED_CRITIQUE_CHARS = 500;

export class EvaluateTaskUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly prompts: PromptBuilderPort,
    private readonly parser: SignalParserPort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: EvaluateTaskInput): Promise<Result<EvaluateTaskOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprint.id,
      taskId: input.task.id,
    });

    const promptResult = await this.prompts.buildEvaluatePrompt({
      task: input.task,
      sprint: input.sprint,
      ...(input.previousCritique !== undefined ? { previousCritique: input.previousCritique } : {}),
    });
    if (!promptResult.ok) return Result.error(promptResult.error);

    log.info('evaluating task', {
      name: input.task.name,
      reEvaluation: input.previousCritique !== undefined,
    });

    const sessionResult = await this.ai.spawnHeadless(promptResult.value, {
      cwd: input.cwd,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const now = IsoTimestamp.now();
    const signals = this.parser.parse(sessionResult.value.output, { now });
    const evaluation = signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

    if (evaluation === undefined) {
      log.warn('evaluator output had no parseable evaluation signal — treating as malformed');
      const synthesised: EvaluationSignal = {
        type: 'evaluation',
        status: 'malformed',
        dimensions: [],
        critique: sessionResult.value.output.slice(0, MAX_MALFORMED_CRITIQUE_CHARS),
        timestamp: now,
      };
      return Result.ok({
        outcome: 'malformed',
        signal: synthesised,
        fullCritique: sessionResult.value.output,
      });
    }

    const outcome: EvaluationOutcome = evaluation.status;
    return Result.ok({
      outcome,
      signal: evaluation,
      fullCritique: sessionResult.value.output,
    });
  }
}
