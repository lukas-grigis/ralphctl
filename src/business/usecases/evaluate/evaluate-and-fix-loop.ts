/**
 * `EvaluateAndFixLoopUseCase` — orchestrate the multi-round
 * generator/evaluator fix loop on a single, settled task.
 *
 * Single round (`evaluationIterations: 1`) → run the evaluator once.
 * `0` → skip evaluation entirely (the loop exits immediately and
 * downstream code treats the task as not-evaluated).
 * `N > 1` → up to N evaluator rounds; on a `failed` round the use case
 * resumes the *generator* with the prior critique injected, re-runs the
 * post-task check, and then re-evaluates. Plateau detection short-circuits
 * the loop when two consecutive `failed` rounds flag the same set of
 * dimensions (Anthropic's harness-design guidance — see
 * `plateau-detection.ts`).
 *
 * **Iteration semantics** — `evaluationIterations: N` is interpreted as
 * "at most N evaluator rounds total". Round 1 is the initial evaluation;
 * rounds 2..N are fix-and-reeval. This matches the legacy default
 * (`1` = "one initial eval, no fix attempt") rather than `1` meaning
 * "1 fix on top of an initial".
 *
 * **Live config** — the iteration cap is re-read from {@link LiveConfigReader}
 * on every loop tick so a settings-panel edit mid-execution applies to the
 * next round (REQ-12).
 *
 * **Never blocks** — the loop **always** returns `Result.ok(...)`. A
 * failed / malformed / plateau outcome is signalled via the structured
 * output and surfaced to the chain layer, which records it on the task
 * but never aborts the per-task chain. (Spawn errors from the evaluator
 * or generator do propagate as `Result.error`; that's a system fault,
 * not an evaluator verdict.)
 */
import type { Sprint } from '../../../domain/entities/sprint.ts';
import type { Task } from '../../../domain/entities/task.ts';
import type { DomainError } from '../../../domain/errors/domain-error.ts';
import { Result } from '../../../domain/result.ts';
import type { EvaluationSignal } from '../../../domain/signals/harness-signal.ts';
import type { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import type { LoggerPort } from '../../ports/logger-port.ts';
import { ExecuteSingleTaskUseCase } from '../execute/execute-single-task.ts';
import { PostTaskCheckUseCase } from '../execute/post-task-check.ts';
import { EvaluateTaskUseCase, type EvaluationOutcome } from './evaluate-task.ts';
import { dimensionsEqual } from './plateau-detection.ts';

/**
 * Narrow shape this use case needs from a live-config provider — only the
 * single field it actually reads. Defined locally so the business layer
 * doesn't import from `application/`. The application's
 * {@link LiveConfigReader} satisfies this structurally; chain factories
 * adapt between the two.
 */
export interface EvaluationConfigReader {
  current(): Promise<{ readonly evaluationIterations: number }>;
}

export interface EvaluateAndFixLoopInput {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly cwd: AbsolutePath;
  /**
   * Resolved check script for the post-task gate after a generator fix
   * round. When omitted, the post-task gate is skipped between rounds.
   */
  readonly checkScript?: string;
  /**
   * Provider session id to resume the generator from on a fix round.
   * Set by the per-task chain after the initial `execute-task` so the
   * fix attempt continues the same conversation.
   */
  readonly resumeSessionId?: string;
  readonly abortSignal?: AbortSignal;
}

export interface EvaluateAndFixLoopOutput {
  /** Number of evaluator rounds actually run (0 when disabled). */
  readonly rounds: number;
  /** Final evaluator signal. `null` when `evaluationIterations: 0`. */
  readonly finalSignal: EvaluationSignal | null;
  /** Final evaluator critique (full text). Empty string when disabled. */
  readonly finalCritique: string;
  /** True when the loop exited because two consecutive rounds flagged the same dimensions. */
  readonly plateauDetected: boolean;
  /** Per-round critiques, in order. Used by the chain layer to render history. */
  readonly history: readonly EvaluationRound[];
}

export interface EvaluationRound {
  readonly round: number;
  readonly outcome: EvaluationOutcome;
  readonly signal: EvaluationSignal;
  readonly critique: string;
}

export class EvaluateAndFixLoopUseCase {
  constructor(
    private readonly liveConfig: EvaluationConfigReader,
    private readonly evaluator: EvaluateTaskUseCase,
    private readonly generator: ExecuteSingleTaskUseCase,
    private readonly checkRunner: PostTaskCheckUseCase,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: EvaluateAndFixLoopInput): Promise<Result<EvaluateAndFixLoopOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprint.id,
      taskId: input.task.id,
    });

    const initialConfig = await this.liveConfig.current();
    if (initialConfig.evaluationIterations <= 0) {
      log.info('evaluator disabled (evaluationIterations: 0)');
      return Result.ok({
        rounds: 0,
        finalSignal: null,
        finalCritique: '',
        plateauDetected: false,
        history: [],
      });
    }

    const history: EvaluationRound[] = [];
    let previousSignal: EvaluationSignal | undefined;
    let previousCritique: string | undefined;
    let resumeSessionId = input.resumeSessionId;
    let plateauDetected = false;

    // Cap is re-read each iteration tick so settings-panel edits apply
    // to the *next* loop check without restart (REQ-12). The exit
    // conditions are all `break` statements inside the body — every
    // round makes progress (round counter increments before any
    // potentially-await side effect), so there is no risk of an
    // unbounded loop.
    let round = 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const cfg = await this.liveConfig.current();
      const cap = cfg.evaluationIterations;
      if (cap <= round) {
        log.info('evaluation cap reached', { rounds: round, cap });
        break;
      }

      round += 1;

      // ── Evaluator round ─────────────────────────────────────────
      const evalResult = await this.evaluator.execute({
        task: input.task,
        sprint: input.sprint,
        cwd: input.cwd,
        ...(previousCritique !== undefined ? { previousCritique } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      if (!evalResult.ok) return Result.error(evalResult.error);

      const { outcome, signal, fullCritique } = evalResult.value;
      history.push({ round, outcome, signal, critique: fullCritique });

      log.info('evaluator round complete', { round, outcome });

      // Exit conditions checked in priority order.
      if (outcome === 'passed') break;
      if (outcome === 'malformed') {
        log.warn('evaluator output malformed — exiting loop', { round });
        break;
      }

      // outcome === 'failed' — check plateau before another fix attempt.
      if (previousSignal !== undefined && dimensionsEqual(previousSignal, signal)) {
        log.warn('evaluator plateau detected — exiting loop', {
          round,
          dimensions: signal.dimensions.filter((d) => !d.passed).map((d) => d.dimension),
        });
        plateauDetected = true;
        break;
      }

      previousSignal = signal;
      previousCritique = fullCritique;

      // No point spawning a fix attempt when the cap is already
      // exhausted — the next round wouldn't run anyway. Re-read the
      // cap so a panel edit "raise iterations" mid-run can still
      // unlock a fix attempt before we exit.
      const nextCfg = await this.liveConfig.current();
      if (nextCfg.evaluationIterations <= round) {
        log.info('evaluation cap reached after failed round — skipping fix attempt', {
          rounds: round,
          cap: nextCfg.evaluationIterations,
        });
        break;
      }

      // ── Generator fix round ─────────────────────────────────────
      log.info('resuming generator with critique', { round });
      const fixResult = await this.generator.execute({
        task: input.task,
        sprint: input.sprint,
        cwd: input.cwd,
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      if (!fixResult.ok) return Result.error(fixResult.error);
      if (fixResult.value.newSessionId !== undefined) {
        resumeSessionId = fixResult.value.newSessionId;
      }

      // ── Post-task check between rounds ──────────────────────────
      if (input.checkScript !== undefined && input.checkScript.length > 0) {
        const checkResult = await this.checkRunner.execute({
          projectPath: input.cwd,
          checkScript: input.checkScript,
        });
        if (!checkResult.ok) return Result.error(checkResult.error);
        if (!checkResult.value.passed) {
          log.warn('post-task check failed after fix attempt — re-evaluating anyway', { round });
        }
      }
    }

    const last = history.length > 0 ? history[history.length - 1] : undefined;
    return Result.ok({
      rounds: history.length,
      finalSignal: last?.signal ?? null,
      finalCritique: last?.critique ?? '',
      plateauDetected,
      history,
    });
  }
}
