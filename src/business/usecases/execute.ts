import type { Task, Sprint, Project } from '@src/domain/models.ts';
import { SpawnError } from '@src/domain/errors.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/domain/repositories/persistence.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/domain/repositories/filesystem.ts';
import type { SignalParserPort } from '../ports/signal-parser.ts';
import type { SignalHandlerPort, SignalContext } from '../ports/signal-handler.ts';
import type { SignalBusPort } from '../ports/signal-bus.ts';
import type { HarnessSignal } from '@src/domain/signals.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopReason =
  | 'all_completed'
  | 'count_reached'
  | 'task_blocked'
  | 'user_paused'
  | 'no_tasks'
  | 'all_blocked';

export interface ExecutionSummary {
  completed: number;
  remaining: number;
  blocked: number;
  stopReason: StopReason;
  exitCode: number;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  output: string;
  sessionId?: string;
  blocked?: string;
  verified?: boolean;
  verificationOutput?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Use Case
//
// Post-pipeline-migration shape: this class is no longer the orchestrator —
// the execute pipeline (`src/business/pipelines/execute.ts`) owns the sprint
// lifecycle and the per-task pipeline (`src/business/pipelines/execute/`)
// composes `forEachTask` to schedule tasks. What remains here are the
// building blocks the pipeline steps delegate to:
//
//   - `executeOneTask`     — spawn the AI, parse signals, return a result
//   - `runPostTaskCheck`   — run the post-task check-gate
//   - `runFeedbackLoopOnly`— drive the optional end-of-sprint feedback loop
//   - `getEvaluationConfig`— fresh config read for REQ-12 live config
//
// Everything else (parallel scheduling, sequential loop, branch management,
// preconditions, summary projection) now lives in the pipeline layer.
// ---------------------------------------------------------------------------

export class ExecuteTasksUseCase {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly aiSession: AiSessionPort,
    private readonly promptBuilder: PromptBuilderPort,
    private readonly parser: OutputParserPort,
    private readonly ui: UserInteractionPort,
    private readonly logger: LoggerPort,
    private readonly external: ExternalPort,
    private readonly fs: FilesystemPort,
    private readonly signalParser: SignalParserPort,
    private readonly signalHandler: SignalHandlerPort,
    private readonly signalBus: SignalBusPort
  ) {}

  // -------------------------------------------------------------------------
  // Task execution
  // -------------------------------------------------------------------------

  /**
   * Execute a single task end-to-end: build prompt, spawn AI, parse signals,
   * return a `TaskExecutionResult` envelope. This is the canonical task body
   * and is called by the per-task pipeline's `execute-task` step.
   *
   * Rate-limit failures re-throw `SpawnError` so the scheduler's retry
   * policy (in the outer `execute-tasks` step) can detect them via the
   * standard cause-chain walk and decide between `pause-all` / `requeue`.
   * Non-rate-limit failures fold into `success: false` — the retry policy
   * treats those as "task not completed" and leaves the task in_progress
   * for resumption.
   */
  async executeOneTask(task: Task, sprint: Sprint, options?: ExecutionOptions): Promise<TaskExecutionResult> {
    const taskLog = this.logger.child({ sprintId: sprint.id, taskId: task.id, projectPath: task.projectPath });
    const sprintDir = this.fs.getSprintDir(sprint.id);
    const context = this.buildTaskContext(task);
    const prompt = this.promptBuilder.buildTaskExecutionPrompt(task, sprint, context);

    const args: string[] = ['--add-dir', sprintDir];
    if (options?.maxTurns != null) args.push('--max-turns', String(options.maxTurns));
    if (options?.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd));
    if (options?.fallbackModel) args.push('--fallback-model', options.fallbackModel);

    if (options?.session) {
      try {
        await this.aiSession.spawnInteractive(prompt, {
          cwd: task.projectPath,
          args,
          env: this.aiSession.getSpawnEnv(),
        });
        return { taskId: task.id, success: true, output: '', verified: true };
      } catch (err) {
        return {
          taskId: task.id,
          success: false,
          output: '',
          blocked: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Headless mode
    const spinner = taskLog.spinner(`${this.aiSession.getProviderDisplayName()} is working on: ${task.name}`);

    try {
      const result = await this.aiSession.spawnWithRetry(prompt, {
        cwd: task.projectPath,
        args,
        env: this.aiSession.getSpawnEnv(),
        maxRetries: options?.maxRetries,
      });

      spinner.succeed(`${this.aiSession.getProviderDisplayName()} completed: ${task.name}`);

      // Dispatch all signals (progress, notes, blocked) through handler
      const ctx: SignalContext = { sprintId: sprint.id, taskId: task.id, projectPath: task.projectPath };
      const allSignals = await this.dispatchSignals(result.output, ctx);

      // Extract lifecycle signals for flow control
      const blockedSignal = allSignals.find((s) => s.type === 'task-blocked');
      const completeSignal = allSignals.find((s) => s.type === 'task-complete');
      const verifiedSignal = allSignals.find((s) => s.type === 'task-verified');

      if (blockedSignal) {
        return {
          taskId: task.id,
          success: false,
          output: result.output,
          blocked: blockedSignal.reason,
          sessionId: result.sessionId,
          model: result.model,
        };
      }

      return {
        taskId: task.id,
        success: completeSignal != null,
        output: result.output,
        verified: verifiedSignal != null,
        verificationOutput: verifiedSignal?.type === 'task-verified' ? verifiedSignal.output : undefined,
        sessionId: result.sessionId,
        model: result.model,
      };
    } catch (err) {
      spinner.fail(`${this.aiSession.getProviderDisplayName()} failed: ${task.name}`);

      // Rate-limit spawn errors propagate as-is so the scheduler's retry
      // policy can walk the cause chain, pause globally, and requeue.
      if (err instanceof SpawnError && err.rateLimited) {
        throw err;
      }

      return { taskId: task.id, success: false, output: '', blocked: err instanceof Error ? err.message : String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Post-task check
  // -------------------------------------------------------------------------

  /**
   * Run the post-task check gate for a single task. Returns `true` if the
   * check passed or there's no script configured — `false` if the check
   * failed. Called by the per-task pipeline's `postTaskCheck` step.
   */
  async runPostTaskCheck(task: Task, sprint: Sprint): Promise<boolean> {
    const project = await this.findProjectForPath(sprint, task.projectPath);
    const checkScript = this.getCheckScript(project, task.projectPath);
    if (!checkScript) return true;

    this.logger.info(`Running post-task check: ${checkScript}`);
    const repo = project?.repositories.find((r) => r.path === task.projectPath);
    const result = this.external.runCheckScript(task.projectPath, checkScript, 'taskComplete', repo?.checkTimeout);

    if (result.passed) {
      this.logger.success('Post-task check: passed');
    }
    return result.passed;
  }

  // -------------------------------------------------------------------------
  // Evaluation config (live, REQ-12)
  // -------------------------------------------------------------------------

  /**
   * Read evaluator configuration fresh from persistence (REQ-12 — live config).
   * Called once per task settlement so the settings panel's mid-execution
   * edits take effect on the next task without requiring a restart.
   *
   * Must never be cached by callers — REQ-12 requires a fresh read per task.
   */
  async getEvaluationConfig(options?: ExecutionOptions): Promise<{ enabled: boolean; iterations: number }> {
    const config = await this.persistence.getConfig();
    const iterations = config.evaluationIterations ?? 1;
    const enabled = iterations > 0 && !options?.noEvaluate && !options?.session;
    return { enabled, iterations };
  }

  // -------------------------------------------------------------------------
  // Feedback loop
  // -------------------------------------------------------------------------

  /**
   * Drive the end-of-sprint feedback loop. Called by the pipeline's
   * `feedback-loop` step after execution completes with all tasks done and
   * the user hasn't opted out via `--no-feedback` / `--session`.
   *
   * The hard cap `MAX_FEEDBACK_ITERATIONS` lives inside this method so the
   * calling step stays a thin adapter.
   */
  async runFeedbackLoopOnly(sprint: Sprint, options?: ExecutionOptions): Promise<void> {
    const MAX_FEEDBACK_ITERATIONS = 10;

    for (let iteration = 0; iteration < MAX_FEEDBACK_ITERATIONS; iteration++) {
      const feedback = await this.ui.getFeedback('All tasks complete. Enter feedback for changes (empty to approve):');

      // null/empty = user approves
      if (!feedback) return;

      await this.persistence.logProgress(`User feedback: ${feedback}`, { sprintId: sprint.id });

      const tasks = await this.persistence.getTasks(sprint.id);
      const completedSummary = tasks
        .filter((t) => t.status === 'done')
        .map((t) => `- ${t.name} (${t.projectPath})`)
        .join('\n');

      const projectPaths = [...new Set(tasks.map((t) => t.projectPath))];

      for (const projectPath of projectPaths) {
        const prompt = this.promptBuilder.buildFeedbackPrompt(sprint.name, completedSummary, feedback, sprint.branch);

        this.logger.info(`Implementing feedback in ${projectPath}...`);
        const spinner = this.logger.spinner('AI is implementing feedback...');

        try {
          const sprintDir = this.fs.getSprintDir(sprint.id);
          const result = await this.aiSession.spawnWithRetry(prompt, {
            cwd: projectPath,
            args: ['--add-dir', sprintDir],
            env: this.aiSession.getSpawnEnv(),
            maxTurns: options?.maxTurns,
          });
          spinner.succeed('Feedback implementation completed');

          const signals = this.parser.parseExecutionSignals(result.output);
          if (signals.blocked) {
            this.logger.warning(`Feedback blocked: ${signals.blocked}`);
          }
        } catch (err) {
          spinner.fail('Feedback implementation failed');
          this.logger.warning(err instanceof Error ? err.message : String(err));
        }
      }

      // Run post-feedback check scripts
      for (const projectPath of projectPaths) {
        const project = await this.findProjectForPath(sprint, projectPath);
        const checkScript = this.getCheckScript(project, projectPath);
        if (checkScript) {
          this.logger.info(`Running checks after feedback: ${checkScript}`);
          const repo = project?.repositories.find((r) => r.path === projectPath);
          const result = this.external.runCheckScript(projectPath, checkScript, 'taskComplete', repo?.checkTimeout);
          if (!result.passed) {
            this.logger.warning(`Check failed after feedback in ${projectPath}`);
          } else {
            this.logger.success(`Checks passed: ${projectPath}`);
          }
        }
      }
    }

    this.logger.warning(`Reached maximum feedback iterations (${String(MAX_FEEDBACK_ITERATIONS)}). Proceeding.`);
  }

  // -------------------------------------------------------------------------
  // Helpers (private)
  // -------------------------------------------------------------------------

  private async findProjectForPath(sprint: Sprint, projectPath: string): Promise<Project | undefined> {
    for (const ticket of sprint.tickets) {
      try {
        const project = await this.persistence.getProject(ticket.projectName);
        if (project.repositories.some((r) => r.path === projectPath)) return project;
      } catch {
        // skip
      }
    }
    return undefined;
  }

  private getCheckScript(project: Project | undefined, projectPath: string): string | null {
    if (!project) return null;
    const repo = project.repositories.find((r) => r.path === projectPath);
    return repo?.checkScript ?? null;
  }

  private buildTaskContext(task: Task): string {
    const sections: string[] = [];

    sections.push(`## Task: ${task.name}`);
    if (task.description) sections.push(task.description);

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
   * Parse all signals from AI output and dispatch to the signal handler.
   * Returns the parsed signals for flow control by the caller.
   */
  private async dispatchSignals(output: string, ctx: SignalContext): Promise<HarnessSignal[]> {
    const signals = this.signalParser.parseSignals(output);

    for (const signal of signals) {
      switch (signal.type) {
        case 'progress':
          await this.signalHandler.handleProgress(signal, ctx);
          break;
        case 'evaluation':
          await this.signalHandler.handleEvaluation(signal, ctx);
          break;
        case 'task-complete':
          // Don't handle here — pipeline manages task lifecycle
          break;
        case 'task-verified':
          // Don't handle here — pipeline manages verification state
          break;
        case 'task-blocked':
          await this.signalHandler.handleTaskBlocked(signal, ctx);
          break;
        case 'note':
          await this.signalHandler.handleNote(signal, ctx);
          break;
        default: {
          const _exhaustive: never = signal;
          void _exhaustive;
        }
      }
      // Broadcast to live subscribers (TUI dashboard). Independent of the
      // durable handler above — dashboard decides what to render.
      this.signalBus.emit({ type: 'signal', signal, ctx });
    }

    return signals;
  }
}
