import { confirm } from '@inquirer/prompts';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { highlight, info, muted, success, warning } from '@src/theme/index.ts';
import { checkTaskPermissions } from '@src/claude/permissions.ts';
import { getNextTask, getRemainingTasks, isTaskBlocked, updateTask, updateTaskStatus } from '@src/store/task.ts';
import { filterProgressByProject, getProgress, logProgress } from '@src/store/progress.ts';
import { getProgressFilePath } from '@src/utils/paths.ts';
import { buildTaskExecutionPrompt } from '@src/claude/prompts/index.ts';
import { getProject, ProjectNotFoundError } from '@src/store/project.ts';
import type { Project, Sprint, Task } from '@src/schemas/index.ts';
import { createSpinner, formatTaskStatus } from '@src/theme/ui.ts';
import { type ExecutionResult, parseExecutionResult } from '@src/claude/parser.ts';
import { spawnClaudeHeadless, spawnClaudeInteractive } from '@src/claude/session.ts';
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
      const pkg = JSON.parse(execSync('cat package.json', { cwd: projectPath, encoding: 'utf-8' })) as {
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

  lines.push(`## Task: ${ctx.task.name}`);
  lines.push(`ID: ${ctx.task.id}`);
  lines.push(`Project: ${ctx.task.projectPath}`);

  if (ctx.task.description) {
    lines.push('');
    lines.push(ctx.task.description);
  }

  if (ctx.task.steps.length > 0) {
    lines.push('');
    lines.push('### Steps');
    ctx.task.steps.forEach((step, i) => {
      lines.push(`${String(i + 1)}. ${step}`);
    });
  }

  return lines.join('\n');
}

/**
 * Build the full task context including git history, progress, and verification info.
 */
function buildFullTaskContext(
  ctx: TaskContext,
  progressHistory: string | null,
  gitHistory: string,
  verifyScript: string | null
): string {
  const lines: string[] = [];

  lines.push(formatTaskForClaude(ctx));

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### Git History (recent commits)');
  lines.push('```');
  lines.push(gitHistory);
  lines.push('```');

  lines.push('');
  lines.push('### Verification Command');
  if (verifyScript) {
    lines.push('```bash');
    lines.push(verifyScript);
    lines.push('```');
  } else {
    lines.push('Read CLAUDE.md in the project root to find verification commands.');
  }

  if (progressHistory) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Progress History');
    lines.push('');
    lines.push(progressHistory);
  }

  return lines.join('\n');
}

async function writeTaskContextFile(projectPath: string, taskContent: string, instructions: string): Promise<string> {
  const contextFile = join(projectPath, '.ralphctl-task-context.md');
  const fullContent = `${taskContent}\n\n---\n\n## Instructions\n\n${instructions}`;
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

async function executeTaskWithClaude(
  ctx: TaskContext,
  options: ExecutorOptions,
  sprintId: string
): Promise<ExecutionResult> {
  const projectPath = ctx.task.projectPath;
  const gitHistory = getRecentGitHistory(projectPath, 20);
  const verifyScript = getEffectiveVerifyScript(ctx.project, projectPath);
  const allProgress = await getProgress(sprintId);
  const progressHistory = filterProgressByProject(allProgress, projectPath);
  const fullTaskContent = buildFullTaskContext(ctx, progressHistory, gitHistory, verifyScript);
  const progressFilePath = getProgressFilePath(sprintId);
  const instructions = buildTaskExecutionPrompt(progressFilePath, options.noCommit);
  const contextFile = await writeTaskContextFile(projectPath, fullTaskContent, instructions);

  try {
    if (options.session) {
      const result = spawnClaudeInteractive('Read .ralphctl-task-context.md and follow the instructions', {
        cwd: projectPath,
      });

      if (result.error) {
        return {
          success: false,
          output: '',
          blockedReason: result.error,
        };
      }

      if (result.code === 0) {
        return { success: true, output: '', verified: true };
      }
      return {
        success: false,
        output: '',
        blockedReason: `Claude exited with code ${String(result.code)}`,
      };
    } else {
      // Headless mode: pass context file content via stdin
      const contextContent = await readFile(contextFile, 'utf-8');
      const spinner = createSpinner('Claude is working...').start();

      try {
        const output = await spawnClaudeHeadless({
          cwd: projectPath,
          prompt: contextContent,
          onSignal: () => {
            spinner.stop();
          },
        });

        spinner.succeed('Claude completed');
        return parseExecutionResult(output);
      } catch (err) {
        spinner.fail('Claude failed');
        throw err;
      }
    }
  } finally {
    try {
      await unlink(contextFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// MAIN EXECUTION LOOP
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
 * Core execution loop - executes tasks from the current sprint.
 * Returns a structured summary of what happened.
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

// Re-export for backward compatibility
export { formatTaskForClaude as formatTaskContext };
