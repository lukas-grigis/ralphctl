import { basename } from 'node:path';
import type { Sprint, Task } from '@src/domain/models.ts';
import { SpawnError } from '@src/domain/errors.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { PersistencePort } from '@src/business/ports/persistence.ts';
import { generateUuid8 } from '@src/domain/ids.ts';
import { truncate } from '@src/domain/strings.ts';
import type { AiSessionPort } from '../ports/ai-session.ts';
import type { PromptBuilderPort } from '../ports/prompt-builder.ts';
import type { OutputParserPort } from '../ports/output-parser.ts';
import type { UserInteractionPort } from '../ports/user-interaction.ts';
import type { LoggerPort } from '../ports/logger.ts';
import type { ExternalPort } from '../ports/external.ts';
import type { FilesystemPort } from '@src/business/ports/filesystem.ts';
import type { SignalParserPort } from '../ports/signal-parser.ts';
import type { SignalContext, SignalHandlerPort } from '../ports/signal-handler.ts';
import type { SignalBusPort } from '../ports/signal-bus.ts';
import type { HarnessSignal } from '@src/domain/signals.ts';
import { findProjectForRepoId, resolveCheckScriptForRepo } from '../pipelines/steps/project-lookup.ts';

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
    // Resolve provider once so sync getters (getSpawnEnv, getProviderDisplayName) are safe below.
    await this.aiSession.ensureReady();

    const repoPath = await this.persistence.resolveRepoPath(task.repoId);

    const taskLog = this.logger.child({ sprintId: sprint.id, taskId: task.id, projectPath: repoPath });
    const sprintDir = this.fs.getSprintDir(sprint.id);

    // Build the per-task context file that the agent will read. The file
    // lives in the PROJECT directory (not sprint dir) so the AI CLI's `cwd`
    // sees it via relative basename — matches the template's `{{CONTEXT_FILE}}`
    // expectation. Content: rich task context + "## Instructions" prompt.
    const progressFilePath = this.fs.getProgressFilePath(sprint.id);
    const contextFilePath = this.fs.getProjectContextFilePath(repoPath, sprint.id, task.id);
    const contextFileName = basename(contextFilePath);

    const fullTaskContext = await this.buildFullTaskContext(task, sprint, repoPath, options?.contractPath);
    const projectToolingSection = this.external.detectProjectTooling([repoPath]);
    const instructions = this.promptBuilder.buildTaskExecutionPrompt(
      progressFilePath,
      contextFileName,
      projectToolingSection,
      options?.noCommit
    );
    const contextFileContent = `${fullTaskContext}\n\n---\n\n## Instructions\n\n${instructions}`;
    await this.fs.writeFile(contextFilePath, contextFileContent);

    // The prompt passed to the AI CLI is a terse "read the file" directive —
    // the real prompt + context live inside the file. Matches the old
    // executor's flow pre-pipeline refactor.
    const spawnPrompt = `Read ${contextFileName} and follow the instructions`;

    const args: string[] = ['--add-dir', sprintDir];
    if (options?.maxTurns != null) args.push('--max-turns', String(options.maxTurns));
    if (options?.maxBudgetUsd != null) args.push('--max-budget-usd', String(options.maxBudgetUsd));
    if (options?.fallbackModel) args.push('--fallback-model', options.fallbackModel);

    if (options?.session) {
      try {
        await this.aiSession.spawnInteractive(spawnPrompt, {
          cwd: repoPath,
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
      } finally {
        // Best-effort cleanup — don't leave the context file in the repo.
        await this.fs.deleteFile(contextFilePath);
      }
    }

    // Headless mode
    const spinner = taskLog.spinner(`${this.aiSession.getProviderDisplayName()} is working on: ${task.name}`);

    try {
      const result = await this.aiSession.spawnWithRetry(spawnPrompt, {
        cwd: repoPath,
        args,
        env: this.aiSession.getSpawnEnv(),
        maxRetries: options?.maxRetries,
        resumeSessionId: options?.resumeSessionId,
      });

      spinner.succeed(`${this.aiSession.getProviderDisplayName()} completed: ${task.name}`);

      // Dispatch all signals (progress, notes, blocked) through handler
      const ctx: SignalContext = { sprintId: sprint.id, taskId: task.id, projectPath: repoPath };
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
    } finally {
      // Best-effort cleanup — don't leave the context file in the repo
      // regardless of whether the spawn succeeded, failed, or rate-limited.
      await this.fs.deleteFile(contextFilePath);
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
    void sprint; // Retained in signature for pipeline symmetry; resolution is by repoId now.
    const resolved = await findProjectForRepoId(this.persistence, task.repoId);
    const checkScript = resolveCheckScriptForRepo(resolved?.repo);
    if (!resolved || !checkScript) return true;

    this.logger.info(`Running post-task check: ${checkScript}`);
    const { repo } = resolved;
    const result = this.external.runCheckScript(repo.path, checkScript, 'taskComplete', repo.checkTimeout);

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
   * Each iteration reads multi-line markdown feedback via the editor prompt
   * and, for each affected repo, runs a *synthetic task* — a `Task` built
   * in-memory (never persisted to `tasks.json`) that reuses the same
   * building blocks as `executeOneTask`:
   *
   *   - `task-started` / `task-finished` emissions to the signal bus keep
   *     the live dashboard ticking.
   *   - `dispatchSignals` routes parsed progress / note / blocked signals
   *     to the durable signal handler so entries land in `progress.md`.
   *   - `runPostTaskCheck` gates each iteration through the same check
   *     script used for real tasks.
   *
   * The hard cap `MAX_FEEDBACK_ITERATIONS` lives inside this method so the
   * calling step stays a thin adapter.
   */
  async runFeedbackLoopOnly(sprint: Sprint, options?: ExecutionOptions): Promise<void> {
    const MAX_FEEDBACK_ITERATIONS = 10;

    // Tasks + repo paths don't change across iterations — resolve once.
    const tasks = await this.persistence.getTasks(sprint.id);
    const repoIds = [...new Set(tasks.map((t) => t.repoId))];
    const repoPathByRepoId = new Map<string, string>();
    for (const repoId of repoIds) {
      try {
        repoPathByRepoId.set(repoId, await this.persistence.resolveRepoPath(repoId));
      } catch {
        // Unresolvable repo id — skip; below loops will no-op for it.
      }
    }
    const completedSummary = tasks
      .filter((t) => t.status === 'done')
      .map((t) => `- ${t.name} (${repoPathByRepoId.get(t.repoId) ?? t.repoId})`)
      .join('\n');

    let iteration = 0;
    for (; iteration < MAX_FEEDBACK_ITERATIONS; iteration++) {
      const feedback = await this.ui.getFeedback('All tasks complete. Enter feedback for changes (empty to approve):');

      // null/empty = user approves
      if (!feedback) return;

      await this.persistence.logProgress(`User feedback: ${feedback}`, { sprintId: sprint.id });

      for (const repoId of repoIds) {
        const repoPath = repoPathByRepoId.get(repoId);
        if (!repoPath) continue;

        const syntheticTask = this.makeFeedbackTask(feedback, repoId);

        // Emit task-started so the dashboard animates this iteration.
        this.signalBus.emit({
          type: 'task-started',
          sprintId: sprint.id,
          taskId: syntheticTask.id,
          taskName: syntheticTask.name,
          timestamp: new Date(),
        });

        let finishStatus: 'done' | 'blocked' | 'failed' = 'done';
        const prompt = this.promptBuilder.buildFeedbackPrompt(sprint.name, completedSummary, feedback, sprint.branch);
        const spinner = this.logger.spinner(
          `${this.aiSession.getProviderDisplayName()} is working on: ${syntheticTask.name}`
        );

        try {
          await this.aiSession.ensureReady();
          const sprintDir = this.fs.getSprintDir(sprint.id);
          const result = await this.aiSession.spawnWithRetry(prompt, {
            cwd: repoPath,
            args: ['--add-dir', sprintDir],
            env: this.aiSession.getSpawnEnv(),
            maxTurns: options?.maxTurns,
          });
          spinner.succeed(`${this.aiSession.getProviderDisplayName()} completed: ${syntheticTask.name}`);

          // Route progress / note / blocked signals to the durable handler so
          // feedback iterations leave an audit trail in progress.md.
          const ctx: SignalContext = { sprintId: sprint.id, taskId: syntheticTask.id, projectPath: repoPath };
          const signals = await this.dispatchSignals(result.output, ctx);
          const blocked = signals.find((s) => s.type === 'task-blocked');
          if (blocked) {
            finishStatus = 'blocked';
            this.logger.warning(`Feedback blocked in ${repoPath}: ${blocked.reason}`);
          }
        } catch (err) {
          spinner.fail(`${this.aiSession.getProviderDisplayName()} failed: ${syntheticTask.name}`);
          finishStatus = 'failed';
          this.logger.warning(err instanceof Error ? err.message : String(err));
        }

        // Post-task check gate. Don't block the loop on failure — warn and move on.
        try {
          const passed = await this.runPostTaskCheck(syntheticTask, sprint);
          if (!passed) {
            this.logger.warning(`Post-feedback check failed in ${repoPath}`);
            if (finishStatus === 'done') finishStatus = 'failed';
          }
        } catch (err) {
          this.logger.warning(
            `Post-feedback check error in ${repoPath}: ${err instanceof Error ? err.message : String(err)}`
          );
          if (finishStatus === 'done') finishStatus = 'failed';
        }

        this.signalBus.emit({
          type: 'task-finished',
          sprintId: sprint.id,
          taskId: syntheticTask.id,
          status: finishStatus,
          timestamp: new Date(),
        });
      }
    }

    if (iteration >= MAX_FEEDBACK_ITERATIONS) {
      this.logger.warning(`Reached maximum feedback iterations (${String(MAX_FEEDBACK_ITERATIONS)}). Proceeding.`);
    }
  }

  /**
   * Build an in-memory `Task` representing a single feedback iteration for a
   * single repo. Never persisted — used only to drive the shared building
   * blocks (`runPostTaskCheck`, signal dispatch, bus lifecycle) without
   * polluting `tasks.json`.
   */
  private makeFeedbackTask(feedback: string, repoId: string): Task {
    return {
      id: `feedback-${generateUuid8()}`,
      name: `Feedback: ${truncate(feedback, 60)}`,
      description: feedback,
      steps: [feedback],
      verificationCriteria: ['Project check script passes'],
      status: 'todo',
      order: 0,
      blockedBy: [],
      repoId,
      verified: false,
      evaluated: false,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers (private)
  // -------------------------------------------------------------------------

  /**
   * Build the full task context markdown for the per-task context file.
   *
   * Layout follows the primacy/recency pattern — high-attention sections
   * at the start (task directive, steps, verification, branch, check
   * script), reference-zone in the middle (prior learnings, ticket reqs,
   * git history), and the "## Instructions" block (written in by the
   * caller) at the end.
   *
   * This restores the rich context the pre-pipeline executor wrote:
   * without these sections the agent loses branch awareness, check-script
   * knowledge, prior progress, ticket scope, and recent commits — all of
   * which the template and dimensions rely on.
   */
  private async buildFullTaskContext(
    task: Task,
    sprint: Sprint,
    repoPath: string,
    contractPath?: string
  ): Promise<string> {
    const lines: string[] = [];

    // ═══ HIGH ATTENTION ZONE (start) ═══
    lines.push(`## Task: ${task.name}`);
    if (task.description) {
      lines.push('');
      lines.push(task.description);
    }
    if (task.steps.length > 0) {
      lines.push('');
      lines.push('## Steps');
      lines.push('');
      lines.push(task.steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n'));
    }
    if (task.verificationCriteria.length > 0) {
      lines.push('');
      lines.push('## Verification Criteria');
      lines.push('');
      lines.push(task.verificationCriteria.map((c) => `- ${c}`).join('\n'));
    }

    lines.push('');
    lines.push(`## Project Path\n${repoPath}`);

    if (sprint.branch) {
      lines.push('');
      lines.push('## Branch');
      lines.push('');
      lines.push(
        `You are working on branch \`${sprint.branch}\`. All commits go to this branch. Do not switch branches.`
      );
    }

    const resolved = await findProjectForRepoId(this.persistence, task.repoId);
    const checkScript = resolveCheckScriptForRepo(resolved?.repo);
    lines.push('');
    lines.push('## Check Script');
    lines.push('');
    if (checkScript) {
      lines.push('The harness runs this command at sprint start and after every task as a post-task gate:');
      lines.push('');
      lines.push('```bash');
      lines.push(checkScript);
      lines.push('```');
      lines.push('');
      lines.push('Your task is NOT marked done unless this command passes after completion.');
    } else {
      lines.push(
        'No check script is configured. Check CLAUDE.md, .github/copilot-instructions.md, or project config for verification commands.'
      );
    }

    if (contractPath) {
      lines.push('');
      lines.push('## Sprint Contract');
      lines.push('');
      lines.push(
        `The grading contract is at \`${contractPath}\` — it consolidates the task, verification criteria, check script, and the dimensions you will be graded on. Read it before implementing.`
      );
    }

    // ═══ REFERENCE ZONE (middle) ═══
    lines.push('');
    lines.push('---');

    const progressSummary = await this.persistence.getProgressSummary(sprint.id, repoPath).catch(() => '');
    if (progressSummary) {
      lines.push('');
      lines.push('## Prior Task Learnings');
      lines.push('');
      lines.push('_Reference — consult when relevant to your implementation._');
      lines.push('');
      lines.push(progressSummary);
    }

    if (task.ticketId) {
      const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
      if (ticket?.requirements) {
        lines.push('');
        lines.push('## Ticket Requirements');
        lines.push('');
        lines.push(
          '_Reference — describes the full ticket scope. This task implements a specific part. Use to validate your work and understand constraints, but follow the Implementation Steps above. Do not expand scope beyond declared steps._'
        );
        lines.push('');
        lines.push(ticket.requirements);
      }
    }

    const gitHistory = this.external.getRecentGitHistory(repoPath, 10);
    lines.push('');
    lines.push('## Git History (recent commits)');
    lines.push('');
    lines.push('```');
    lines.push(gitHistory);
    lines.push('```');

    return lines.join('\n');
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
