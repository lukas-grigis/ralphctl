/**
 * `EvaluateTaskUseCase` — run a generator/evaluator code review on a
 * settled task. Spawns one autonomous AI session and parses the verdict.
 *
 * Single-responsibility: one evaluator round. The fix-and-re-evaluate loop
 * (with plateau detection, iterations cap, persisting the sidecar) is a
 * chain-layer concern — this use case takes a pre-rendered evaluator
 * prompt file (the chain leaf or the loop produces it) and returns a
 * structured outcome.
 *
 * Malformed-output policy: if the parser finds no `EvaluationSignal`, this
 * use case synthesises one with `status: 'malformed'`, empty dimensions,
 * and the first 500 chars of the raw output as `critique`. The chain layer
 * persists the full text to the sidecar file. The evaluator never blocks
 * a task — task always proceeds to `done`, even on `failed` / `malformed`.
 */
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { AiSessionPort } from '@src/business/ports/ai-session-port.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { SignalHandlerPort } from '@src/business/ports/signal-handler-port.ts';
import type { SignalParserPort } from '@src/business/ports/signal-parser-port.ts';
import { buildAdditionalCwdArgs } from '@src/business/usecases/_shared/add-dir-args.ts';
import { renderFileHandoffWrapper } from '@src/business/usecases/_shared/file-handoff-wrapper.ts';

/** Possible outcomes of one evaluator round. */
export type EvaluationOutcome = 'passed' | 'failed' | 'malformed';

export interface EvaluateTaskInput {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly cwd: AbsolutePath;
  /**
   * Absolute path to the per-round evaluator prompt file produced by
   * the chain leaf (single round) or the multi-round loop (per-round
   * re-render with the latest `previousCritique`). Required — the
   * wrapper handed to the AI points at this path.
   */
  readonly promptFilePath: string;
  /**
   * Extra read roots the evaluator session should be able to see. Set by
   * the per-task chain to the evaluate workspace root so the evaluator
   * can read upstream contract files (refined requirements, full task
   * plan, dimension definitions, prior sibling evaluations) — Claude
   * receives them as `--add-dir <root>` flags. Empty / undefined for
   * Copilot (no `--add-dir` equivalent — the workspace builder mirrors
   * the repo into the sandbox instead) and for the standalone
   * `sprint evaluate` chain (no workspace).
   */
  readonly addDirs?: readonly AbsolutePath[];
  /**
   * Optional absolute path the AI session adapter writes a `session.md`
   * audit record to. Set per evaluator round to a `session-N.md` under
   * the per-task execution unit folder. Best-effort.
   */
  readonly sessionMdPath?: AbsolutePath;
  readonly abortSignal?: AbortSignal;
}

export interface EvaluateTaskOutput {
  readonly outcome: EvaluationOutcome;
  /** The evaluation signal — synthesised as malformed when none was emitted. */
  readonly signal: EvaluationSignal;
  /**
   * Raw evaluator stdout — the chain layer persists this under
   * `rounds/<N>/evaluator/evaluation.md` (per-round) and
   * `latest-evaluation.md` (stable pointer). This use case stays IO-free.
   */
  readonly fullCritique: string;
}

const MAX_MALFORMED_CRITIQUE_CHARS = 500;

export class EvaluateTaskUseCase {
  constructor(
    private readonly ai: AiSessionPort,
    private readonly parser: SignalParserPort,
    private readonly logger: LoggerPort,
    private readonly signalHandler?: SignalHandlerPort
  ) {}

  async execute(input: EvaluateTaskInput): Promise<Result<EvaluateTaskOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprint.id,
      taskId: input.task.id,
    });

    // The full evaluator prompt is on disk at `input.promptFilePath`.
    // Hand the AI a thin wrapper pointing at it — the AI reads the file
    // as its first action.
    const wrapper = renderFileHandoffWrapper(input.promptFilePath);

    log.info(`evaluating task ${String(input.task.id)}${formatNameSuffix(input.task.name)}`);

    const extraArgs = buildAdditionalCwdArgs(input.addDirs);
    const sessionResult = await this.ai.spawnHeadless(wrapper, {
      cwd: input.cwd,
      ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      ...(input.sessionMdPath !== undefined ? { sessionMdPath: input.sessionMdPath } : {}),
    });
    if (!sessionResult.ok) return Result.error(sessionResult.error);

    const now = IsoTimestamp.now();
    const signals = this.parser.parse(sessionResult.value.output, { now });
    const evaluation = signals.find((s): s is EvaluationSignal => s.type === 'evaluation');

    const persistSignal = async (signal: EvaluationSignal): Promise<void> => {
      if (this.signalHandler === undefined) return;
      try {
        const handled = await this.signalHandler.handle(signal, {
          sprintId: input.sprint.id,
          taskId: input.task.id,
          taskName: input.task.name,
        });
        if (!handled.ok) {
          log.warn('evaluate-task: signal handler failed to persist evaluation', {
            error: handled.error.message,
          });
        }
      } catch (err) {
        log.warn('evaluate-task: signal handler threw unexpectedly', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (evaluation === undefined) {
      log.warn('evaluator output had no parseable evaluation signal — treating as malformed');
      const synthesised: EvaluationSignal = {
        type: 'evaluation',
        status: 'malformed',
        dimensions: [],
        critique: sessionResult.value.output.slice(0, MAX_MALFORMED_CRITIQUE_CHARS),
        timestamp: now,
      };
      await persistSignal(synthesised);
      return Result.ok({
        outcome: 'malformed',
        signal: synthesised,
        fullCritique: sessionResult.value.output,
      });
    }

    await persistSignal(evaluation);
    const outcome: EvaluationOutcome = evaluation.status;
    return Result.ok({
      outcome,
      signal: evaluation,
      fullCritique: sessionResult.value.output,
    });
  }
}

/**
 * Render a task name slice for log messages — parallel evaluator rounds all
 * logging "evaluating task" is unreadable; including the task id + name keeps
 * lines distinguishable. Empty / whitespace-only names return '' so the
 * caller can concatenate without a dangling ` — ""`. Clips at 50 chars.
 */
function formatNameSuffix(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  const max = 50;
  const slice = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return ` — "${slice}"`;
}
