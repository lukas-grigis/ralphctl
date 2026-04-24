import type { AiProvider, EvaluationStatus, Sprint, Task } from '@src/domain/models.ts';
import { DomainError, SpawnError, SprintNotFoundError, TaskNotFoundError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { EvaluationOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import type { AiSessionPort, SessionResult } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { EvaluationParseResult, OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import { findProjectForRepoId, resolveCheckScriptForRepo } from '../pipelines/steps/project-lookup.ts';
import { dimensionsEqual } from './plateau.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max characters persisted in tasks.json `evaluationOutput` (prevents bloat). */
const MAX_EVAL_OUTPUT = 2000;

/** Max agentic turns for evaluator — lower than executor's budget. */
const EVALUATOR_MAX_TURNS = 100;

// ---------------------------------------------------------------------------
// Model Ladder
// ---------------------------------------------------------------------------

/**
 * Determine the evaluator model based on the generator's model.
 *
 * Claude ladder (version-agnostic prefix match — Opus 4.5/4.6/4.7 all
 * cascade to Sonnet, same for any future Opus or Sonnet point-release):
 *   Opus   → claude-sonnet-4-6
 *   Sonnet → claude-haiku-4-5
 *   Haiku  → claude-haiku-4-5
 *
 * Other providers: null (no model control).
 *
 * Exported so the pure mapping is independently testable; the use case
 * calls it directly.
 */
export function getEvaluatorModel(generatorModel: string | null, provider: AiProvider): string | null {
  if (provider !== 'claude' || !generatorModel) return null;

  const modelLower = generatorModel.toLowerCase();
  if (modelLower.includes('opus')) return 'claude-sonnet-4-6';
  if (modelLower.includes('sonnet')) return 'claude-haiku-4-5';
  return 'claude-haiku-4-5'; // haiku or unknown -> haiku
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPassed(result: EvaluationParseResult): boolean {
  return result.status === 'passed';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvaluationSummary {
  taskId: string;
  status: 'passed' | 'failed' | 'malformed' | 'skipped' | 'plateau';
  iterations: number;
  dimensions?: { dimension: string; status: string; description: string }[];
}

// ---------------------------------------------------------------------------
// Use Case
// ---------------------------------------------------------------------------

export class EvaluateTaskUseCase {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly aiSession: AiSessionPort,
    private readonly promptBuilder: PromptBuilderPort,
    private readonly parser: OutputParserPort,
    private readonly ui: UserInteractionPort,
    private readonly logger: LoggerPort,
    private readonly fs: FilesystemPort,
    private readonly external: ExternalPort
  ) {}

  async execute(
    sprintId: string,
    taskId: string,
    options?: EvaluationOptions
  ): Promise<Result<EvaluationSummary, DomainError>> {
    const log = this.logger.child({ sprintId, taskId });

    try {
      // Resolve provider once so the sync getters are safe below.
      await this.aiSession.ensureReady();

      // Load task and sprint
      const task = await this.loadTask(sprintId, taskId);
      const sprint = await this.loadSprint(sprintId);

      // Resolve evaluation iterations
      const config = await this.persistence.getConfig();
      const maxIterations = options?.iterations ?? config.evaluationIterations ?? 1;

      if (maxIterations <= 0) {
        return Result.ok({
          taskId,
          status: 'skipped',
          iterations: 0,
        });
      }

      // Resolve provider info for model ladder
      const provider = this.aiSession.getProviderName();
      const generatorModel = options?.fallbackModel ?? null;

      // Resolve the task's repo path once — threaded through the fix loop
      // for spawn cwd + prompt rendering.
      const repoPath = await this.persistence.resolveRepoPath(task.repoId);

      // Pre-compute per-task sections once — both inputs (sprint config, repo
      // tooling) are stable for the duration of the fix loop, so resolving
      // them per-iteration would re-read the filesystem and re-walk the
      // tickets for no gain.
      const checkScriptSection = await this.resolveCheckScriptSection(task);
      const projectToolingSection = this.external.detectProjectTooling([repoPath]);

      // Run the initial evaluation
      const stopEval = log.time('evaluator-spawn');
      let evalResult = await this.runSingleEvaluation(
        task,
        sprint,
        repoPath,
        generatorModel,
        provider,
        checkScriptSection,
        projectToolingSection,
        options
      );
      stopEval();

      // Persist the initial evaluation sidecar (iteration 1)
      await this.persistEvaluation(sprintId, taskId, 1, evalResult);

      let totalIterations = 1;
      let plateaued = false;

      // Fix loop: up to maxIterations fix attempts after the initial evaluation.
      // Bail if passed or malformed (feeding garbage to the generator is wasteful).
      //
      // Loop shape: on iteration `i` we resume the generator with the critique,
      // then — UNLESS it's the last iteration — re-evaluate and check for
      // plateau. Skipping the re-eval on the last fix saves a multi-minute
      // evaluator spawn per task: we've already exhausted the fix budget, so
      // re-running the evaluator only to persist "still failing" burns time
      // without changing the outcome. The final persisted state is the
      // critique from the LAST re-eval (iteration `maxIterations - 1`) or the
      // initial eval when `maxIterations === 1`.
      for (let i = 0; i < maxIterations && !isPassed(evalResult) && evalResult.status !== 'malformed'; i++) {
        log.warning(`Evaluation failed for ${task.name} — fix attempt ${String(i + 1)}/${String(maxIterations)}`);

        // Resume generator with critique. `fixSuccess` reflects whether the
        // generator emitted `<task-complete>`; it's a useful diagnostic but
        // NOT a gate on re-evaluation. The evaluator — not the generator's
        // self-report — is the arbiter of "did the fix work", so we always
        // re-evaluate regardless and let the evaluator settle the question.
        const fixSuccess = await this.resumeGeneratorWithCritique(
          task,
          sprint,
          repoPath,
          evalResult.rawOutput,
          options
        );

        if (!fixSuccess) {
          log.debug(`Fix attempt ${String(i + 1)}: generator did not signal completion — re-evaluating anyway`);
        }

        // Last fix attempt — skip the re-eval to save an evaluator spawn.
        // We're out of fix budget, so a re-eval here can only confirm failure
        // (or luckily pass) without giving the generator another chance to
        // fix anything. Ending on the generator keeps the sidecar's final
        // critique truthful (the one that drove the fix) and shaves a
        // multi-minute Claude run off every failing task.
        if (i === maxIterations - 1) break;

        // Re-evaluate
        const previousEvalResult = evalResult;
        const stopReeval = log.time('evaluator-re-spawn');
        evalResult = await this.runSingleEvaluation(
          task,
          sprint,
          repoPath,
          generatorModel,
          provider,
          checkScriptSection,
          projectToolingSection,
          options
        );
        stopReeval();

        totalIterations++;

        // Plateau detection: if the evaluator keeps flagging the same set of
        // failed dimensions, further fix attempts are wasteful. Persist the
        // sidecar with `'plateau'` so the record is distinguishable from a
        // normal failure, then break.
        if (
          !isPassed(evalResult) &&
          evalResult.status !== 'malformed' &&
          dimensionsEqual(previousEvalResult, evalResult)
        ) {
          plateaued = true;
          await this.persistEvaluation(sprintId, taskId, i + 2, evalResult, 'plateau');
          break;
        }

        await this.persistEvaluation(sprintId, taskId, i + 2, evalResult);
      }

      // Plateau coerces the persisted task status — the critique is genuine,
      // but we want downstream readers (tasks.json, UI) to see this as a
      // distinct outcome from a plain failure.
      const finalStatus: EvaluationStatus = plateaued ? 'plateau' : evalResult.status;

      // Persist evaluation fields on the task
      await this.updateTaskEvaluation(sprintId, taskId, evalResult, finalStatus);

      // Report final status — use the *actual* iteration count, not the
      // configured maximum. The two can differ when the loop breaks early
      // (plateau), or when the generator couldn't fix the issues.
      this.reportResult(task.name, evalResult, totalIterations, plateaued);

      return Result.ok({
        taskId,
        status: finalStatus,
        iterations: totalIterations,
        dimensions: evalResult.dimensions.map((d) => ({
          dimension: d.dimension,
          status: d.status,
          description: d.description,
        })),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return Result.error(err);
      }
      return Result.error(
        new SpawnError(
          `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
          '',
          1,
          null,
          err instanceof Error ? err : undefined
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadTask(sprintId: string, taskId: string): Promise<Task> {
    try {
      return await this.persistence.getTask(taskId, sprintId);
    } catch {
      throw new TaskNotFoundError(taskId);
    }
  }

  private async loadSprint(sprintId: string): Promise<Sprint> {
    try {
      return await this.persistence.getSprint(sprintId);
    } catch {
      throw new SprintNotFoundError(sprintId);
    }
  }

  /**
   * Spawn a single evaluator session and parse the result.
   *
   * `checkScriptSection` and `projectToolingSection` are passed in
   * pre-resolved — both are stable across fix-loop iterations, so the
   * caller computes them once and threads them through.
   */
  private async runSingleEvaluation(
    task: Task,
    sprint: Sprint,
    repoPath: string,
    generatorModel: string | null,
    provider: AiProvider,
    checkScriptSection: string | null,
    projectToolingSection: string,
    options?: EvaluationOptions
  ): Promise<EvaluationParseResult> {
    const evaluatorModel = getEvaluatorModel(generatorModel, provider);
    const sprintDir = this.fs.getSprintDir(sprint.id);

    const prompt = this.promptBuilder.buildTaskEvaluationPrompt(
      task,
      repoPath,
      checkScriptSection,
      projectToolingSection
    );

    const args: string[] = ['--add-dir', sprintDir];
    if (provider === 'claude') {
      if (evaluatorModel) {
        args.push('--model', evaluatorModel);
      }
      args.push('--max-turns', String(options?.maxTurns ?? EVALUATOR_MAX_TURNS));
    }

    let result: SessionResult;
    try {
      result = await this.aiSession.spawnWithRetry(prompt, {
        cwd: repoPath,
        args,
        env: this.aiSession.getSpawnEnv(),
        abortSignal: options?.abortSignal,
      });
    } catch (err) {
      // Evaluator spawn failure — return malformed so evaluation never blocks
      this.logger.warning(
        `Evaluator spawn failed for ${task.name}: ${err instanceof Error ? err.message : String(err)} — marking malformed`
      );
      return {
        status: 'malformed',
        dimensions: [],
        rawOutput: `Evaluator spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return this.parser.parseEvaluation(result.output);
  }

  /**
   * Resolve the repo's `checkScript` and render it as the evaluator's
   * "Computational Gate" markdown block. Returns `null` when nothing is
   * configured so the caller can skip the placeholder cleanly.
   *
   * Uses the same shared `findProjectForPath` + `resolveCheckScript` helpers
   * that the execute pipeline's `run-check-scripts` step uses — one place
   * owns project lookup rules.
   */
  private async resolveCheckScriptSection(task: Task): Promise<string | null> {
    const resolved = await findProjectForRepoId(this.persistence, task.repoId);
    const checkScript = resolveCheckScriptForRepo(resolved?.repo);
    if (!checkScript) return null;
    // Header is H4 (`####`) because the evaluator template injects this
    // section under `### Phase 1` — using `##` here would demote the
    // section out of its parent Phase and confuse the markdown hierarchy.
    return [
      '#### Check Script (Computational Gate)',
      '',
      'Run this check script as the **first step** of your review — it is the same gate the harness uses post-task:',
      '',
      '```',
      checkScript,
      '```',
      '',
      'If this script fails, the implementation fails regardless of code quality. Record the full output.',
    ].join('\n');
  }

  /**
   * Resume the generator session with the evaluator critique.
   *
   * Two load-bearing properties:
   *
   *   1. Prompt uses the full `task-evaluation-resume.md` template via
   *      `promptBuilder.buildTaskEvaluationResumePrompt` — signals block,
   *      fix protocol, harness context, optional commit instruction — so
   *      the generator knows exactly how to re-verify and signal. The
   *      previous 4-line inline prompt silently dropped signal requirements
   *      and led to fix attempts that never signalled completion.
   *
   *   2. When `options.generatorSessionId` is set, the fix is dispatched
   *      with `resumeSessionId` so the provider's `--resume` is honored and
   *      the fix conversation is a continuation of the original task
   *      session — not a fresh cold-start that has to rediscover the code
   *      from scratch. This is the Anthropic-recommended pattern for
   *      generator-evaluator loops. Absent a session ID (rare fallback
   *      path), we spawn fresh and log at debug level.
   *
   * Returns true if the generator signaled `<task-complete>`. The caller
   * uses this as a diagnostic only — the evaluator, not the generator's
   * self-report, is the arbiter of "did the fix work".
   */
  private async resumeGeneratorWithCritique(
    task: Task,
    sprint: Sprint,
    repoPath: string,
    critique: string,
    options?: EvaluationOptions
  ): Promise<boolean> {
    const sprintDir = this.fs.getSprintDir(sprint.id);
    const needsCommit = options?.needsCommit ?? true;
    const resumePrompt = this.promptBuilder.buildTaskEvaluationResumePrompt(critique, needsCommit);
    const resumeSessionId = options?.generatorSessionId;

    this.logger.debug(
      resumeSessionId
        ? `Resuming generator session ${resumeSessionId} for fix attempt: ${task.name}`
        : `No generator session ID — spawning fresh fix attempt: ${task.name}`
    );

    let spinner: SpinnerHandle | null = null;
    try {
      spinner = this.logger.spinner(`Fixing evaluation issues: ${task.name}`);

      const result = await this.aiSession.spawnWithRetry(resumePrompt, {
        cwd: repoPath,
        args: ['--add-dir', sprintDir],
        env: this.aiSession.getSpawnEnv(),
        maxTurns: options?.maxTurns,
        resumeSessionId,
        abortSignal: options?.abortSignal,
      });

      spinner.succeed(`Fix attempt completed: ${task.name}`);

      const signals = this.parser.parseExecutionSignals(result.output);
      return signals.complete;
    } catch {
      spinner?.fail(`Fix attempt failed: ${task.name}`);
      return false;
    }
  }

  /**
   * Persist a real evaluation entry to the sidecar file.
   *
   * `statusOverride` exists for plateau: the parsed result is still a real
   * `'failed'` critique (so `body` stays the raw output), but the status
   * column in the sidecar header records `'plateau'` so readers can tell a
   * loop-derived bail from a one-shot failure.
   */
  private async persistEvaluation(
    sprintId: string,
    taskId: string,
    iteration: number,
    evalResult: EvaluationParseResult,
    statusOverride?: EvaluationStatus
  ): Promise<void> {
    const body =
      evalResult.status === 'malformed' ? '_(evaluator output had no parseable signal)_' : evalResult.rawOutput;
    const status: EvaluationStatus = statusOverride ?? evalResult.status;

    try {
      await this.persistence.writeEvaluation(sprintId, taskId, iteration, status, body);
    } catch {
      this.logger.warning(`Could not persist evaluation sidecar for task ${taskId}`);
    }
  }

  /**
   * Update the task record with evaluation fields.
   *
   * `statusOverride` is set when plateau detection fires: the critique body
   * is still saved (truncated) for traceability, but the discriminator in
   * `tasks.json` records `'plateau'` so consumers can distinguish it from
   * a plain `'failed'` run.
   */
  private async updateTaskEvaluation(
    sprintId: string,
    taskId: string,
    evalResult: EvaluationParseResult,
    statusOverride?: EvaluationStatus
  ): Promise<void> {
    const status: EvaluationStatus = statusOverride ?? evalResult.status;
    const tasks = await this.persistence.getTasks(sprintId);
    const updatedTasks = tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            evaluated: true,
            evaluationStatus: status,
            evaluationOutput: evalResult.rawOutput.slice(0, MAX_EVAL_OUTPUT),
          }
        : t
    );
    await this.persistence.saveTasks(updatedTasks, sprintId);
  }

  /**
   * Report the evaluation outcome to the user.
   *
   * `totalIterations` is the *actual* number of evaluator spawns (initial +
   * any re-evaluations after fix attempts), NOT the configured maximum.
   * When the loop breaks early (plateau), runs out of fix budget, or skips
   * the final re-eval, these two diverge — and the log line must reflect
   * reality so "6 fix attempts" never shows up when only 1 actually ran.
   *
   * The evaluator is advisory: a failing outcome doesn't stop the task
   * from being marked done; the sprint proceeds. The critique is persisted
   * in the sidecar for later review, and the warning log lets the user
   * see what didn't pass without scrolling the evaluations directory.
   */
  private reportResult(
    taskName: string,
    evalResult: EvaluationParseResult,
    totalIterations: number,
    plateaued: boolean
  ): void {
    if (plateaued) {
      this.logger.warning(
        `Evaluation plateaued on the same failures after ${String(totalIterations)} iteration(s): ${taskName}`
      );
    } else if (evalResult.status === 'malformed') {
      this.logger.warning(`Evaluator output was malformed for ${taskName}`);
    } else if (!isPassed(evalResult)) {
      this.logger.warning(
        `Evaluation did not pass after ${String(totalIterations)} iteration(s) — marking done: ${taskName}`
      );
    } else {
      this.logger.success(`Evaluation passed: ${taskName}`);
    }
  }
}
