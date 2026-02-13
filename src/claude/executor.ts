import { confirm } from '@inquirer/prompts';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { highlight, info, muted, success, warning } from '@src/theme/index.ts';
import { checkTaskPermissions } from '@src/claude/permissions.ts';
import { ProcessManager } from '@src/claude/process-manager.ts';
import {
  getNextTask,
  getReadyTasks,
  getRemainingTasks,
  getTasks,
  isTaskBlocked,
  updateTask,
  updateTaskStatus,
} from '@src/store/task.ts';
import { getProgress, logProgress, summarizeProgressForContext } from '@src/store/progress.ts';
import { getProgressFilePath, getSprintDir } from '@src/utils/paths.ts';
import { buildTaskExecutionPrompt } from '@src/claude/prompts/index.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import type { Project, Sprint, Task } from '@src/schemas/index.ts';
import { createSpinner, formatTaskStatus } from '@src/theme/ui.ts';
import { type ExecutionResult, parseExecutionResult } from '@src/claude/parser.ts';
import type { SpawnResult } from '@src/claude/session.ts';
import { ClaudeSpawnError, spawnClaudeInteractive, spawnClaudeWithRetry } from '@src/claude/session.ts';
import { RateLimitCoordinator } from '@src/claude/rate-limiter.ts';
import { EXIT_ALL_BLOCKED, EXIT_ERROR, EXIT_NO_TASKS, EXIT_SUCCESS } from '@src/utils/exit-codes.ts';
import { getSprint } from '@src/store/sprint.ts';

// ============================================================================
// TYPES
// ============================================================================

export interface ExecutorOptions {
  /** Step through tasks with approval between each */
  step: boolean;
  /** Limit number of tasks to execute */
  count: number | null;
  /** Interactive Claude session (collaborate with Claude) */
  session: boolean;
  /** Skip auto-commit after task completion */
  noCommit: boolean;
  /** Max parallel tasks (undefined = auto based on unique repos) */
  concurrency?: number;
  /** Max rate-limit retries per task */
  maxRetries?: number;
  /** Stop launching new tasks on first failure */
  failFast?: boolean;
}

/** Reason why execution stopped */
export type StopReason =
  | 'all_completed' // All tasks done
  | 'count_reached' // Reached task count limit
  | 'task_blocked' // A task could not be completed
  | 'user_paused' // User chose not to continue in interactive mode
  | 'no_tasks' // No tasks available
  | 'all_blocked'; // All remaining tasks blocked by dependencies

export interface ExecutionSummary {
  /** Number of tasks completed in this run */
  completed: number;
  /** Number of remaining tasks */
  remaining: number;
  /** Why execution stopped */
  stopReason: StopReason;
  /** Task that caused pause (if stopReason is task_blocked) */
  blockedTask: Task | null;
  /** Reason for block (if any) */
  blockedReason: string | null;
  /** Exit code for CLI */
  exitCode: number;
}

export interface TaskContext {
  sprint: Sprint;
  task: Task;
  project?: Project;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get recent git history for a project path.
 */
export function getRecentGitHistory(projectPath: string, count = 20): string {
  try {
    const result = execSync(`git log -${String(count)} --oneline --no-decorate`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return '(Unable to retrieve git history)';
  }
}

/**
 * Detect verification script based on project files.
 */
export function detectVerifyScript(projectPath: string): string | null {
  // Node.js/npm projects
  if (existsSync(join(projectPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      const commands: string[] = [];

      if (scripts['lint']) commands.push('npm run lint');
      if (scripts['typecheck']) commands.push('npm run typecheck');
      if (scripts['test']) commands.push('npm run test');

      if (commands.length > 0) {
        return commands.join(' && ');
      }
      return null;
    } catch {
      return null;
    }
  }

  // Python projects
  if (existsSync(join(projectPath, 'pyproject.toml')) || existsSync(join(projectPath, 'setup.py'))) {
    return 'pytest';
  }

  // Go projects
  if (existsSync(join(projectPath, 'go.mod'))) {
    return 'go test ./...';
  }

  // Rust projects
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    return 'cargo test';
  }

  // Java/Gradle projects
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    return './gradlew check';
  }

  // Java/Maven projects
  if (existsSync(join(projectPath, 'pom.xml'))) {
    return 'mvn verify';
  }

  // Makefile projects
  if (existsSync(join(projectPath, 'Makefile'))) {
    return 'make check || make test';
  }

  return null;
}

/**
 * Get effective verify script for a project repository.
 * Finds the matching repository by path and returns its verify script,
 * or falls back to auto-detection.
 */
export function getEffectiveVerifyScript(project: Project | undefined, projectPath: string): string | null {
  if (project) {
    // Find the repository that matches the project path
    const repo = project.repositories.find((r) => r.path === projectPath);
    if (repo?.verifyScript) {
      return repo.verifyScript;
    }
  }
  return detectVerifyScript(projectPath);
}

function formatTaskForClaude(ctx: TaskContext): string {
  const lines: string[] = [];

  // ═══ TASK DIRECTIVE (highest attention) ═══
  lines.push('## Task Directive');
  lines.push('');
  lines.push(`**Task:** ${ctx.task.name}`);
  lines.push(`**ID:** ${ctx.task.id}`);
  lines.push(`**Project:** ${ctx.task.projectPath}`);
  lines.push('');
  lines.push('**ONE TASK ONLY.** Complete THIS task and nothing else. Do not continue to other tasks.');

  if (ctx.task.description) {
    lines.push('');
    lines.push(ctx.task.description);
  }

  // ═══ TASK STEPS (primary content — positioned first for maximum attention) ═══
  if (ctx.task.steps.length > 0) {
    lines.push('');
    lines.push('## Implementation Steps');
    lines.push('');
    lines.push('Follow these steps precisely and in order:');
    lines.push('');
    ctx.task.steps.forEach((step, i) => {
      lines.push(`${String(i + 1)}. ${step}`);
    });
  }

  return lines.join('\n');
}

/**
 * Build the full task context with primacy/recency optimization.
 *
 * Layout applies the primacy/recency effect:
 * - HIGH ATTENTION (start): Task directive, steps, verification
 * - REFERENCE (middle): Prior learnings, ticket requirements, git history
 * - HIGH ATTENTION (end): Instructions (appended by writeTaskContextFile)
 */
function buildFullTaskContext(
  ctx: TaskContext,
  progressSummary: string | null,
  gitHistory: string,
  verifyScript: string | null
): string {
  const lines: string[] = [];

  // ═══ HIGH ATTENTION ZONE (beginning) ═══

  lines.push(formatTaskForClaude(ctx));

  // Verification command — near the top so it's easy to find
  lines.push('');
  lines.push('## Verification Command');
  lines.push('');
  if (verifyScript) {
    lines.push('```bash');
    lines.push(verifyScript);
    lines.push('```');
  } else {
    lines.push('Read CLAUDE.md in the project root to find verification commands.');
  }

  // ═══ REFERENCE ZONE (middle — lower attention is OK) ═══

  lines.push('');
  lines.push('---');
  lines.push('');

  // Prior task learnings (summarized, not raw progress dump)
  if (progressSummary) {
    lines.push('## Prior Task Learnings');
    lines.push('');
    lines.push('_Reference — consult when relevant to your implementation._');
    lines.push('');
    lines.push(progressSummary);
    lines.push('');
  }

  // Ticket requirements (reference only, explicitly deprioritized)
  if (ctx.task.ticketId) {
    const ticket = ctx.sprint.tickets.find((t) => t.id === ctx.task.ticketId);
    if (ticket?.requirements) {
      lines.push('## Ticket Requirements');
      lines.push('');
      lines.push(
        '_Reference — these describe the full ticket scope. This task implements a specific part. ' +
          'Use to validate your work and understand constraints, but follow the Implementation Steps above. ' +
          'Do not expand scope beyond declared steps._'
      );
      lines.push('');
      lines.push(ticket.requirements);
      lines.push('');
    }
  }

  // Git history — awareness of recent changes
  lines.push('## Git History (recent commits)');
  lines.push('');
  lines.push('```');
  lines.push(gitHistory);
  lines.push('```');

  // ═══ HIGH ATTENTION ZONE (end) — Instructions appended by writeTaskContextFile ═══

  return lines.join('\n');
}

function getContextFileName(sprintId: string, taskId: string): string {
  return `.ralphctl-sprint-${sprintId}-task-${taskId}-context.md`;
}

async function writeTaskContextFile(
  projectPath: string,
  taskContent: string,
  instructions: string,
  sprintId: string,
  taskId: string
): Promise<string> {
  const contextFile = join(projectPath, getContextFileName(sprintId, taskId));
  const warning = `<!-- TEMPORARY FILE - DO NOT COMMIT -->
<!-- This file is auto-generated by ralphctl for task execution context -->
<!-- It will be automatically cleaned up after task completion -->

`;
  const fullContent = `${warning}${taskContent}\n\n---\n\n## Instructions\n\n${instructions}`;
  await writeFile(contextFile, fullContent, 'utf-8');
  return contextFile;
}

/**
 * Try to get the project for a task (via ticket reference).
 */
async function getProjectForTask(task: Task, sprint: Sprint): Promise<Project | undefined> {
  if (!task.ticketId) return undefined;

  const ticket = sprint.tickets.find((t) => t.id === task.ticketId);
  if (!ticket) return undefined;

  try {
    return await getProject(ticket.projectName);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return undefined;
    }
    throw err;
  }
}

// ============================================================================
// PERMISSION CHECKS
// ============================================================================

/**
 * Run pre-flight permission checks and display any warnings.
 */
function runPreFlightCheck(ctx: TaskContext, noCommit: boolean): void {
  const verifyScript = getEffectiveVerifyScript(ctx.project, ctx.task.projectPath);

  // Find the repository that matches the project path for setup script
  const repo = ctx.project?.repositories.find((r) => r.path === ctx.task.projectPath);
  const setupScript = repo?.setupScript;

  const warnings = checkTaskPermissions(ctx.task.projectPath, {
    verifyScript,
    setupScript,
    needsCommit: !noCommit,
  });

  if (warnings.length > 0) {
    console.log(warning('\n  Permission warnings:'));
    for (const w of warnings) {
      console.log(muted(`    - ${w.message}`));
    }
    console.log(muted('  Consider adding to .claude/settings.local.json allow list\n'));
  }
}

// ============================================================================
// TASK EXECUTION
// ============================================================================

/** Extended result that includes session ID for resume capability */
interface TaskExecutionResult extends ExecutionResult {
  sessionId: string | null;
}

async function executeTaskWithClaude(
  ctx: TaskContext,
  options: ExecutorOptions,
  sprintId: string,
  resumeSessionId?: string
): Promise<TaskExecutionResult> {
  const projectPath = ctx.task.projectPath;
  const sprintDir = getSprintDir(sprintId);

  if (options.session) {
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const verifyScript = getEffectiveVerifyScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, verifyScript);
    const progressFilePath = getProgressFilePath(sprintId);
    const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit, contextFileName);
    const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions, sprintId, ctx.task.id);

    try {
      const result = spawnClaudeInteractive(`Read ${contextFileName} and follow the instructions`, {
        cwd: projectPath,
        args: ['--add-dir', sprintDir],
      });

      if (result.error) {
        return { success: false, output: '', blockedReason: result.error, sessionId: null };
      }

      if (result.code === 0) {
        return { success: true, output: '', verified: true, sessionId: null };
      }
      return {
        success: false,
        output: '',
        blockedReason: `Claude exited with code ${String(result.code)}`,
        sessionId: null,
      };
    } finally {
      try {
        await unlink(contextFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // Headless mode
  let spawnResult: SpawnResult;

  if (resumeSessionId) {
    // Resume a previous session — send a short continuation prompt
    const spinner = createSpinner(`Resuming Claude session for: ${ctx.task.name}`).start();

    // Register spinner cleanup with ProcessManager
    const manager = ProcessManager.getInstance();
    const deregister = manager.registerCleanup(() => {
      spinner.stop();
    });

    try {
      spawnResult = await spawnClaudeWithRetry(
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir],
          prompt: 'Continue where you left off. Complete the task and signal completion.',
          resumeSessionId,
        },
        {
          maxRetries: options.maxRetries,
          onRetry: (attempt, delayMs) => {
            spinner.text = `Rate limited, retrying in ${String(Math.round(delayMs / 1000))}s (attempt ${String(attempt)})...`;
          },
        }
      );
      spinner.succeed(`Claude completed: ${ctx.task.name}`);
    } catch (err) {
      spinner.fail(`Claude failed: ${ctx.task.name}`);
      throw err;
    } finally {
      deregister(); // Clean up callback registration
    }
  } else {
    // Fresh session — build full context
    const contextFileName = getContextFileName(sprintId, ctx.task.id);
    const gitHistory = getRecentGitHistory(projectPath, 20);
    const verifyScript = getEffectiveVerifyScript(ctx.project, projectPath);
    const allProgress = await getProgress(sprintId);
    const progressSummary = summarizeProgressForContext(allProgress, projectPath, 3);
    const fullTaskContent = buildFullTaskContext(ctx, progressSummary || null, gitHistory, verifyScript);
    const progressFilePath = getProgressFilePath(sprintId);
    const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit, contextFileName);
    const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions, sprintId, ctx.task.id);

    const spinner = createSpinner(`Claude is working on: ${ctx.task.name}`).start();

    // Register spinner cleanup with ProcessManager
    const manager = ProcessManager.getInstance();
    const deregister = manager.registerCleanup(() => {
      spinner.stop();
    });

    try {
      const contextContent = await readFile(contextFile, 'utf-8');
      spawnResult = await spawnClaudeWithRetry(
        {
          cwd: projectPath,
          args: ['--add-dir', sprintDir],
          prompt: contextContent,
        },
        {
          maxRetries: options.maxRetries,
          onRetry: (attempt, delayMs) => {
            spinner.text = `Rate limited, retrying in ${String(Math.round(delayMs / 1000))}s (attempt ${String(attempt)})...`;
          },
        }
      );
      spinner.succeed(`Claude completed: ${ctx.task.name}`);
    } catch (err) {
      spinner.fail(`Claude failed: ${ctx.task.name}`);
      throw err;
    } finally {
      deregister(); // Clean up callback registration
      try {
        await unlink(contextFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  const parsed = parseExecutionResult(spawnResult.stdout);
  return { ...parsed, sessionId: spawnResult.sessionId };
}

// ============================================================================
// SEQUENTIAL EXECUTION LOOP
// ============================================================================

/**
 * Check if all remaining tasks are blocked by dependencies.
 */
async function areAllRemainingBlocked(sprintId: string): Promise<boolean> {
  const remaining = await getRemainingTasks(sprintId);
  if (remaining.length === 0) return false;

  for (const task of remaining) {
    if (task.status === 'in_progress') return false;
    const blocked = await isTaskBlocked(task.id, sprintId);
    if (!blocked) return false;
  }
  return true;
}

/**
 * Sequential execution loop - executes tasks one at a time.
 * Used for session mode, step mode, or --concurrency 1.
 */
export async function executeTaskLoop(sprintId: string, options: ExecutorOptions): Promise<ExecutionSummary> {
  const sprint = await getSprint(sprintId);
  let completedCount = 0;
  const targetCount = options.count ?? Infinity;

  // Check for resumability - find in_progress task
  const firstTask = await getNextTask(sprintId);
  if (firstTask?.status === 'in_progress') {
    console.log(warning(`\nResuming from: ${firstTask.id} - ${firstTask.name}`));
  }

  // Main implementation loop
  while (completedCount < targetCount) {
    const task = await getNextTask(sprintId);

    if (!task) {
      // Check if all remaining tasks are blocked
      if (await areAllRemainingBlocked(sprintId)) {
        const remaining = await getRemainingTasks(sprintId);
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: 'all_blocked',
          blockedTask: null,
          blockedReason: 'All remaining tasks are blocked by dependencies',
          exitCode: EXIT_ALL_BLOCKED,
        };
      }

      // Truly no tasks
      const remaining = await getRemainingTasks(sprintId);
      if (remaining.length === 0 && completedCount === 0) {
        return {
          completed: 0,
          remaining: 0,
          stopReason: 'no_tasks',
          blockedTask: null,
          blockedReason: null,
          exitCode: EXIT_NO_TASKS,
        };
      }

      console.log(success('\nAll tasks completed!'));
      return {
        completed: completedCount,
        remaining: 0,
        stopReason: 'all_completed',
        blockedTask: null,
        blockedReason: null,
        exitCode: EXIT_SUCCESS,
      };
    }

    console.log(info(`\n--- Task ${String(task.order)}: ${task.name} ---`));
    console.log(info('ID:      ') + task.id);
    console.log(info('Project: ') + task.projectPath);
    console.log(info('Status:  ') + formatTaskStatus(task.status));

    // Mark as in_progress if not already
    if (task.status !== 'in_progress') {
      await updateTaskStatus(task.id, 'in_progress', sprintId);
      console.log(muted('Status updated to: in_progress'));
    }

    // Get project for the task (if available)
    const project = await getProjectForTask(task, sprint);

    // Build context for Claude
    const ctx: TaskContext = { sprint, task, project };
    const taskPrompt = formatTaskForClaude(ctx);

    // Run pre-flight permission check (only on first task of the loop)
    if (completedCount === 0) {
      runPreFlightCheck(ctx, options.noCommit);
    }

    if (options.session) {
      console.log(highlight('\n[Task Context for Claude]'));
      console.log(muted('─'.repeat(50)));
      console.log(taskPrompt);
      console.log(muted('─'.repeat(50)));
      console.log(muted(`\nStarting Claude in ${task.projectPath} (session)...\n`));
    } else {
      console.log(muted(`Starting Claude in ${task.projectPath} (headless)...`));
    }

    // Execute task with Claude
    const result = await executeTaskWithClaude(ctx, options, sprintId);

    if (!result.success) {
      console.log(warning('\nTask not completed.'));
      if (result.blockedReason) {
        console.log(warning(`Reason: ${result.blockedReason}`));
      }
      console.log(muted('\nExecution paused. Task remains in_progress.'));
      console.log(muted(`Resume with: ralphctl sprint start ${sprintId}\n`));

      const remaining = await getRemainingTasks(sprintId);
      return {
        completed: completedCount,
        remaining: remaining.length,
        stopReason: 'task_blocked',
        blockedTask: task,
        blockedReason: result.blockedReason ?? 'Unknown reason',
        exitCode: EXIT_ERROR,
      };
    }

    // Store verification result if available
    if (result.verified) {
      await updateTask(
        task.id,
        {
          verified: true,
          verificationOutput: result.verificationOutput,
        },
        sprintId
      );
      console.log(success('Verification: passed'));
    }

    // Update task status: in_progress → done
    await updateTaskStatus(task.id, 'done', sprintId);
    console.log(success('Status updated to: done'));

    // Log automatic progress
    await logProgress(
      `Completed task: ${task.id} - ${task.name}\n\n` +
        (task.description ? `Description: ${task.description}\n` : '') +
        (task.steps.length > 0 ? `Steps:\n${task.steps.map((s, i) => `  ${String(i + 1)}. ${s}`).join('\n')}` : ''),
      { sprintId, projectPath: task.projectPath }
    );

    completedCount++;

    // Interactive mode: confirm before continuing
    if (options.step && completedCount < targetCount) {
      const remaining = await getRemainingTasks(sprintId);
      if (remaining.length > 0) {
        console.log(info(`\n${String(remaining.length)} task(s) remaining.`));
        const continueLoop = await confirm({
          message: 'Continue to next task?',
          default: true,
        });
        if (!continueLoop) {
          console.log(muted('\nExecution paused.'));
          console.log(muted(`Resume with: ralphctl sprint start ${sprintId}\n`));
          return {
            completed: completedCount,
            remaining: remaining.length,
            stopReason: 'user_paused',
            blockedTask: null,
            blockedReason: null,
            exitCode: EXIT_SUCCESS,
          };
        }
      }
    }
  }

  // Reached count limit
  const remaining = await getRemainingTasks(sprintId);
  return {
    completed: completedCount,
    remaining: remaining.length,
    stopReason: remaining.length === 0 ? 'all_completed' : 'count_reached',
    blockedTask: null,
    blockedReason: null,
    exitCode: EXIT_SUCCESS,
  };
}

// ============================================================================
// PARALLEL EXECUTION LOOP
// ============================================================================

interface ParallelTaskResult {
  task: Task;
  result: TaskExecutionResult | null;
  error: Error | null;
  /** Whether this failure is a rate limit (should retry, not count as failure) */
  isRateLimited: boolean;
}

/**
 * Pick tasks to launch: one per unique projectPath, respecting concurrency limit.
 * Excludes repos that already have an in-flight task.
 */
function pickTasksToLaunch(
  readyTasks: Task[],
  inFlightPaths: Set<string>,
  concurrencyLimit: number,
  currentInFlight: number
): Task[] {
  const available = readyTasks.filter((t) => !inFlightPaths.has(t.projectPath));

  // Deduplicate by projectPath — pick the first (lowest order) task per repo
  const byPath = new Map<string, Task>();
  for (const task of available) {
    if (!byPath.has(task.projectPath)) {
      byPath.set(task.projectPath, task);
    }
  }

  const candidates = [...byPath.values()];
  const slotsAvailable = concurrencyLimit - currentInFlight;
  return candidates.slice(0, Math.max(0, slotsAvailable));
}

/**
 * Parallel execution loop - runs tasks concurrently across different repos.
 * At most one task per projectPath runs at a time to avoid git conflicts.
 */
export async function executeTaskLoopParallel(sprintId: string, options: ExecutorOptions): Promise<ExecutionSummary> {
  const sprint = await getSprint(sprintId);
  let completedCount = 0;
  const targetCount = options.count ?? Infinity;
  const failFast = options.failFast ?? false;
  let hasFailed = false;
  let firstBlockedTask: Task | null = null;
  let firstBlockedReason: string | null = null;

  // Determine concurrency limit (hard cap prevents resource exhaustion)
  const MAX_CONCURRENCY = 10;
  const allTasks = await getTasks(sprintId);
  const uniqueRepoPaths = new Set(allTasks.map((t) => t.projectPath));
  const concurrencyLimit = Math.min(options.concurrency ?? uniqueRepoPaths.size, MAX_CONCURRENCY);

  console.log(muted(`Parallel mode: up to ${String(concurrencyLimit)} concurrent task(s)`));

  // Set up rate limit coordinator
  const coordinator = new RateLimitCoordinator({
    onPause: (delayMs) => {
      console.log(warning(`\nRate limited. Pausing new launches for ${String(Math.round(delayMs / 1000))}s...`));
    },
    onResume: () => {
      console.log(success('Rate limit cooldown ended. Resuming launches.'));
    },
  });

  // Track in-flight tasks and session IDs for resume
  const inFlightPaths = new Set<string>();
  const running = new Map<string, Promise<ParallelTaskResult>>();
  const taskSessionIds = new Map<string, string>(); // taskId → Claude session ID
  let preFlightDone = false;

  try {
    // Check for resumable in_progress tasks
    const inProgressTasks = allTasks.filter((t) => t.status === 'in_progress');
    if (inProgressTasks.length > 0) {
      console.log(warning(`\nResuming ${String(inProgressTasks.length)} in-progress task(s):`));
      for (const t of inProgressTasks) {
        console.log(warning(`  - ${t.id}: ${t.name}`));
      }
    }

    while (completedCount < targetCount) {
      // Wait if rate limited before checking for new tasks
      await coordinator.waitIfPaused();

      // Get current task state from disk
      const readyTasks = await getReadyTasks(sprintId);

      // Also check for in_progress tasks (resumable)
      const currentTasks = await getTasks(sprintId);
      const inProgress = currentTasks.filter((t) => t.status === 'in_progress' && !running.has(t.id));

      // Combine: resume in_progress first, then ready tasks
      const launchCandidates = [...inProgress, ...readyTasks.filter((t) => !inProgress.some((ip) => ip.id === t.id))];

      if (launchCandidates.length === 0 && running.size === 0) {
        // Nothing to run and nothing in flight
        const remaining = await getRemainingTasks(sprintId);
        if (remaining.length === 0) {
          if (completedCount === 0) {
            return {
              completed: 0,
              remaining: 0,
              stopReason: 'no_tasks',
              blockedTask: null,
              blockedReason: null,
              exitCode: EXIT_NO_TASKS,
            };
          }
          console.log(success('\nAll tasks completed!'));
          return {
            completed: completedCount,
            remaining: 0,
            stopReason: 'all_completed',
            blockedTask: null,
            blockedReason: null,
            exitCode: EXIT_SUCCESS,
          };
        }

        // Tasks exist but none are launchable — all blocked
        return {
          completed: completedCount,
          remaining: remaining.length,
          stopReason: hasFailed ? 'task_blocked' : 'all_blocked',
          blockedTask: firstBlockedTask,
          blockedReason: firstBlockedReason ?? 'All remaining tasks are blocked by dependencies',
          exitCode: hasFailed ? EXIT_ERROR : EXIT_ALL_BLOCKED,
        };
      }

      // Pick tasks to launch (if we should)
      if (!hasFailed || !failFast) {
        const toStart = pickTasksToLaunch(launchCandidates, inFlightPaths, concurrencyLimit, running.size);

        for (const task of toStart) {
          if (completedCount + running.size >= targetCount) break;

          // Run pre-flight check once
          if (!preFlightDone) {
            const project = await getProjectForTask(task, sprint);
            const ctx: TaskContext = { sprint, task, project };
            runPreFlightCheck(ctx, options.noCommit);
            preFlightDone = true;
          }

          // Mark as in_progress
          if (task.status !== 'in_progress') {
            await updateTaskStatus(task.id, 'in_progress', sprintId);
          }

          // Check if we have a session ID to resume from (rate-limit recovery)
          const resumeId = taskSessionIds.get(task.id);
          const action = resumeId ? 'Resuming' : 'Starting';

          console.log(info(`\n--- ${action} task ${String(task.order)}: ${task.name} ---`));
          console.log(info('ID:      ') + task.id);
          console.log(info('Project: ') + task.projectPath);
          if (resumeId) {
            console.log(muted(`Resuming Claude session ${resumeId.slice(0, 8)}...`));
          } else {
            console.log(muted(`Starting Claude in ${task.projectPath} (headless)...`));
          }

          inFlightPaths.add(task.projectPath);

          const taskPromise = (async (): Promise<ParallelTaskResult> => {
            try {
              const project = await getProjectForTask(task, sprint);
              const ctx: TaskContext = { sprint, task, project };
              const result = await executeTaskWithClaude(ctx, options, sprintId, resumeId);

              // Store session ID for potential future resume
              if (result.sessionId) {
                taskSessionIds.set(task.id, result.sessionId);
              }

              return { task, result, error: null, isRateLimited: false };
            } catch (err) {
              if (err instanceof ClaudeSpawnError && err.rateLimited) {
                // Store session ID from error for resume after cooldown
                if (err.sessionId) {
                  taskSessionIds.set(task.id, err.sessionId);
                }
                const delay = err.retryAfterMs ?? 60_000;
                coordinator.pause(delay);

                return {
                  task,
                  result: null,
                  error: err,
                  isRateLimited: true,
                };
              }

              return {
                task,
                result: null,
                error: err instanceof Error ? err : new Error(String(err)),
                isRateLimited: false,
              };
            } finally {
              inFlightPaths.delete(task.projectPath);
            }
          })();

          running.set(task.id, taskPromise);
        }
      }

      // Wait for any task to complete
      if (running.size === 0) {
        // Nothing launched and nothing running — stop
        break;
      }

      // Wait for first task to complete, then check rate limit state and launch next batch
      const settled = await Promise.race([...running.values()]);
      running.delete(settled.task.id);

      // Process the result
      if (settled.error) {
        if (settled.isRateLimited) {
          // Rate limit — not a real failure, will be re-queued after cooldown
          const sessionId = taskSessionIds.get(settled.task.id);
          console.log(warning(`\nRate limited: ${settled.task.name}`));
          if (sessionId) {
            console.log(muted(`Session saved for resume: ${sessionId.slice(0, 8)}...`));
          }
          console.log(muted('Will retry after cooldown.'));
          // Don't set hasFailed — this task will be re-launched on next loop iteration
          continue;
        }

        // Real error
        console.log(warning(`\nTask failed: ${settled.task.name}`));
        console.log(warning(`Error: ${settled.error.message}`));
        console.log(muted(`Task ${settled.task.id} remains in_progress for resumption.`));

        hasFailed = true;
        if (!firstBlockedTask) {
          firstBlockedTask = settled.task;
          firstBlockedReason = settled.error.message;
        }

        if (failFast) {
          console.log(muted('Fail-fast: waiting for running tasks to finish...'));
        }
        continue;
      }

      if (settled.result && !settled.result.success) {
        console.log(warning(`\nTask not completed: ${settled.task.name}`));
        if (settled.result.blockedReason) {
          console.log(warning(`Reason: ${settled.result.blockedReason}`));
        }
        console.log(muted(`Task ${settled.task.id} remains in_progress.`));

        hasFailed = true;
        if (!firstBlockedTask) {
          firstBlockedTask = settled.task;
          firstBlockedReason = settled.result.blockedReason ?? 'Unknown reason';
        }

        if (failFast) {
          console.log(muted('Fail-fast: waiting for running tasks to finish...'));
        }
        continue;
      }

      // Task completed successfully
      if (settled.result) {
        // Store verification result
        if (settled.result.verified) {
          await updateTask(
            settled.task.id,
            {
              verified: true,
              verificationOutput: settled.result.verificationOutput,
            },
            sprintId
          );
          console.log(success(`Verification passed: ${settled.task.name}`));
        }

        // Mark done
        await updateTaskStatus(settled.task.id, 'done', sprintId);
        console.log(success(`Completed: ${settled.task.name}`));

        // Clean up session tracking
        taskSessionIds.delete(settled.task.id);

        // Log progress
        await logProgress(
          `Completed task: ${settled.task.id} - ${settled.task.name}\n\n` +
            (settled.task.description ? `Description: ${settled.task.description}\n` : '') +
            (settled.task.steps.length > 0
              ? `Steps:\n${settled.task.steps.map((s, i) => `  ${String(i + 1)}. ${s}`).join('\n')}`
              : ''),
          { sprintId, projectPath: settled.task.projectPath }
        );

        completedCount++;
      }
    }

    // Wait for any remaining in-flight tasks
    if (running.size > 0) {
      console.log(muted(`\nWaiting for ${String(running.size)} remaining task(s)...`));
      const remaining = await Promise.allSettled([...running.values()]);
      for (const r of remaining) {
        if (r.status === 'fulfilled' && r.value.result?.success) {
          if (r.value.result.verified) {
            await updateTask(
              r.value.task.id,
              { verified: true, verificationOutput: r.value.result.verificationOutput },
              sprintId
            );
          }
          await updateTaskStatus(r.value.task.id, 'done', sprintId);
          console.log(success(`Completed: ${r.value.task.name}`));
          await logProgress(`Completed task: ${r.value.task.id} - ${r.value.task.name}`, {
            sprintId,
            projectPath: r.value.task.projectPath,
          });
          completedCount++;
        }
      }
    }
  } finally {
    coordinator.dispose();
  }

  const remainingTasks = await getRemainingTasks(sprintId);

  if (hasFailed) {
    return {
      completed: completedCount,
      remaining: remainingTasks.length,
      stopReason: 'task_blocked',
      blockedTask: firstBlockedTask,
      blockedReason: firstBlockedReason,
      exitCode: EXIT_ERROR,
    };
  }

  return {
    completed: completedCount,
    remaining: remainingTasks.length,
    stopReason: remainingTasks.length === 0 ? 'all_completed' : 'count_reached',
    blockedTask: null,
    blockedReason: null,
    exitCode: EXIT_SUCCESS,
  };
}

// Re-export for backward compatibility
export { formatTaskForClaude as formatTaskContext };
