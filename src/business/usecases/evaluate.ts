import type { Task, Sprint, AiProvider } from '@src/domain/models.ts';
import { DomainError, SpawnError, SprintNotFoundError, TaskNotFoundError } from '@src/domain/errors.ts';
import { Result } from '@src/domain/types.ts';
import type { EvaluationOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { AiSessionPort, SessionResult } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort, EvaluationParseResult } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort, SpinnerHandle } from '../ports/logger.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';

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
 * Claude: Opus -> Sonnet, Sonnet -> Haiku, Haiku -> Haiku.
 * Other providers: null (no model control).
 */
function getEvaluatorModel(generatorModel: string | null, provider: AiProvider): string | null {
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
  status: 'passed' | 'failed' | 'malformed' | 'skipped';
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
    private readonly fs: FilesystemPort
  ) {}

  async execute(
    sprintId: string,
    taskId: string,
    options?: EvaluationOptions
  ): Promise<Result<EvaluationSummary, DomainError>> {
    const log = this.logger.child({ sprintId, taskId });

    try {
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

      // Run the initial evaluation
      const stopEval = log.time('evaluator-spawn');
      let evalResult = await this.runSingleEvaluation(task, sprint, generatorModel, provider, options);
      stopEval();

      // Persist the initial evaluation sidecar (iteration 1)
      await this.persistEvaluation(sprintId, taskId, 1, evalResult);

      let totalIterations = 1;

      // Fix loop: up to maxIterations fix attempts after the initial evaluation.
      // Bail if passed or malformed (feeding garbage to the generator is wasteful).
      for (let i = 0; i < maxIterations && !isPassed(evalResult) && evalResult.status !== 'malformed'; i++) {
        log.warning(`Evaluation failed for ${task.name} — fix attempt ${String(i + 1)}/${String(maxIterations)}`);

        // Resume generator with critique
        const fixSuccess = await this.resumeGeneratorWithCritique(task, sprint, evalResult.rawOutput, options);

        if (!fixSuccess) {
          const reason = 'Generator could not fix issues after feedback';
          await this.persistEvaluationStub(sprintId, taskId, i + 2, reason);
          break;
        }

        // Re-evaluate
        const stopReeval = log.time('evaluator-re-spawn');
        evalResult = await this.runSingleEvaluation(task, sprint, generatorModel, provider, options);
        stopReeval();

        totalIterations++;
        await this.persistEvaluation(sprintId, taskId, i + 2, evalResult);
      }

      // Persist evaluation fields on the task
      await this.updateTaskEvaluation(sprintId, taskId, evalResult);

      // Report final status
      this.reportResult(task.name, evalResult, maxIterations);

      return Result.ok({
        taskId,
        status: evalResult.status,
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
   */
  private async runSingleEvaluation(
    task: Task,
    sprint: Sprint,
    generatorModel: string | null,
    provider: AiProvider,
    options?: EvaluationOptions
  ): Promise<EvaluationParseResult> {
    const evaluatorModel = getEvaluatorModel(generatorModel, provider);
    const sprintDir = this.fs.getSprintDir(sprint.id);

    const context = this.buildEvaluationContext(task);
    const prompt = this.promptBuilder.buildTaskEvaluationPrompt(task, sprint, context);

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
        cwd: task.projectPath,
        args,
        env: this.aiSession.getSpawnEnv(),
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
   * Build context string for the evaluator prompt.
   */
  private buildEvaluationContext(task: Task): string {
    const sections: string[] = [];

    sections.push(`## Task: ${task.name}`);
    if (task.description) {
      sections.push(task.description);
    }

    if (task.steps.length > 0) {
      sections.push('## Steps');
      sections.push(task.steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n'));
    }

    if (task.verificationCriteria.length > 0) {
      sections.push('## Verification Criteria');
      sections.push(task.verificationCriteria.map((c) => `- ${c}`).join('\n'));
    }

    sections.push(`## Project Path\n${task.projectPath}`);

    return sections.join('\n\n');
  }

  /**
   * Resume the generator session with the evaluator critique.
   * Returns true if the generator signaled completion.
   */
  private async resumeGeneratorWithCritique(
    task: Task,
    sprint: Sprint,
    critique: string,
    options?: EvaluationOptions
  ): Promise<boolean> {
    const sprintDir = this.fs.getSprintDir(sprint.id);
    const resumePrompt = [
      'The evaluator found issues with your implementation. Fix them and signal completion.',
      '',
      '## Evaluator Critique',
      critique,
    ].join('\n');

    let spinner: SpinnerHandle | null = null;
    try {
      spinner = this.logger.spinner(`Fixing evaluation issues: ${task.name}`);

      const result = await this.aiSession.spawnWithRetry(resumePrompt, {
        cwd: task.projectPath,
        args: ['--add-dir', sprintDir],
        env: this.aiSession.getSpawnEnv(),
        maxTurns: options?.maxTurns,
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
   */
  private async persistEvaluation(
    sprintId: string,
    taskId: string,
    iteration: number,
    evalResult: EvaluationParseResult
  ): Promise<void> {
    const body =
      evalResult.status === 'malformed' ? '_(evaluator output had no parseable signal)_' : evalResult.rawOutput;

    try {
      await this.persistence.writeEvaluation(sprintId, taskId, iteration, evalResult.status, body);
    } catch {
      this.logger.warning(`Could not persist evaluation sidecar for task ${taskId}`);
    }
  }

  /**
   * Persist a stub entry when the fix loop bails early.
   */
  private async persistEvaluationStub(
    sprintId: string,
    taskId: string,
    iteration: number,
    reason: string
  ): Promise<void> {
    try {
      await this.persistence.writeEvaluation(sprintId, taskId, iteration, 'failed', `_(no re-evaluation: ${reason})_`);
    } catch {
      this.logger.warning(`Could not persist evaluation stub for task ${taskId}`);
    }
  }

  /**
   * Update the task record with evaluation fields.
   */
  private async updateTaskEvaluation(
    sprintId: string,
    taskId: string,
    evalResult: EvaluationParseResult
  ): Promise<void> {
    const tasks = await this.persistence.getTasks(sprintId);
    const updatedTasks = tasks.map((t) =>
      t.id === taskId
        ? {
            ...t,
            evaluated: true,
            evaluationStatus: evalResult.status,
            evaluationOutput: evalResult.rawOutput.slice(0, MAX_EVAL_OUTPUT),
          }
        : t
    );
    await this.persistence.saveTasks(updatedTasks, sprintId);
  }

  /**
   * Report the evaluation outcome to the user.
   */
  private reportResult(taskName: string, evalResult: EvaluationParseResult, maxIterations: number): void {
    if (evalResult.status === 'malformed') {
      this.logger.warning(`Evaluator output was malformed for ${taskName} — marking done`);
    } else if (!isPassed(evalResult)) {
      this.logger.warning(
        `Evaluation did not pass after ${String(maxIterations)} fix attempt(s) — marking done: ${taskName}`
      );
    } else {
      this.logger.success(`Evaluation passed: ${taskName}`);
    }
  }
}
