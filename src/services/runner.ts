import { confirm } from '@inquirer/prompts';
import { info, success, warning, muted, highlight } from '@src/utils/colors.ts';
import {
  getScope,
  resolveScopeId,
  ScopeStatusError,
} from '@src/services/scope.ts';
import {
  getNextTask,
  updateTaskStatus,
  getRemainingTasks,
  areAllTasksDone,
  formatTaskStatus,
} from '@src/services/task.ts';
import { logProgress } from '@src/services/progress.ts';
import type { Scope, Task, Ticket } from '@src/schemas/index.ts';

export interface RunnerOptions {
  interactive: boolean;
  count: number | null;
}

export interface TaskContext {
  scope: Scope;
  task: Task;
  ticket: Ticket | undefined;
  stepIndex: number;
}

function formatTaskForClaude(ctx: TaskContext): string {
  const lines: string[] = [];

  lines.push(`## Task: ${ctx.task.name}`);
  lines.push(`ID: ${ctx.task.id}`);
  lines.push(`Order: ${String(ctx.task.order)}`);

  if (ctx.task.description) {
    lines.push(`\nDescription: ${ctx.task.description}`);
  }

  if (ctx.ticket) {
    lines.push(`\n### Ticket: ${ctx.ticket.id}`);
    lines.push(`Title: ${ctx.ticket.title}`);
    if (ctx.ticket.description) {
      lines.push(`Description: ${ctx.ticket.description}`);
    }
    if (ctx.ticket.link) {
      lines.push(`Link: ${ctx.ticket.link}`);
    }
  }

  if (ctx.task.steps.length > 0) {
    lines.push('\n### Implementation Steps:');
    ctx.task.steps.forEach((step, i) => {
      lines.push(`${String(i + 1)}. ${step}`);
    });
  }

  return lines.join('\n');
}

export async function runScope(
  scopeId: string | undefined,
  options: RunnerOptions
): Promise<void> {
  const id = await resolveScopeId(scopeId);
  const scope = await getScope(id);

  // Validate scope is active
  if (scope.status !== 'active') {
    throw new ScopeStatusError(
      `Scope must be active to start. Current status: ${scope.status}`
    );
  }

  console.log(info('\n=== Scope Start ==='));
  console.log(info('Scope: ') + scope.name);
  console.log(info('ID:    ') + scope.id);

  if (options.interactive) {
    console.log(muted('Mode: Interactive (will pause after each task)'));
  }
  if (options.count) {
    console.log(muted(`Limit: ${String(options.count)} task(s)`));
  }

  // Check for resumability - find in_progress task
  const nextTask = await getNextTask(id);
  if (nextTask?.status === 'in_progress') {
    console.log(warning(`\nResuming from: ${nextTask.id} - ${nextTask.name}`));
  }

  let completedCount = 0;
  const targetCount = options.count ?? Infinity;

  // Main implementation loop
  while (completedCount < targetCount) {
    const task = await getNextTask(id);

    if (!task) {
      console.log(success('\nAll tasks completed!'));
      break;
    }

    console.log(info(`\n--- Task ${String(task.order)}: ${task.name} ---`));
    console.log(info('ID:     ') + task.id);
    console.log(info('Status: ') + formatTaskStatus(task.status));

    // Mark as in_progress if not already
    if (task.status !== 'in_progress') {
      await updateTaskStatus(task.id, 'in_progress', id);
      console.log(muted('Status updated to: in_progress'));
    }

    // Get ticket context
    const ticket = scope.tickets.find((t) => t.id === task.ticketId);

    // Build context for Claude
    const ctx: TaskContext = { scope, task, ticket, stepIndex: 0 };
    const taskPrompt = formatTaskForClaude(ctx);

    console.log(highlight('\n[Task Context for Claude]'));
    console.log(muted('─'.repeat(50)));
    console.log(taskPrompt);
    console.log(muted('─'.repeat(50)));

    // In a real implementation, this would invoke Claude
    // For now, we just display the context and prompt for manual completion
    console.log(
      warning('\nClaude integration pending. Please implement this task manually.')
    );
    console.log(muted('When done, the task will be marked as testing, then done.'));

    const proceed = await confirm({
      message: 'Mark task as done and continue?',
      default: true,
    });

    if (!proceed) {
      console.log(muted('\nScope paused. Task remains in_progress.'));
      console.log(muted(`Resume with: ralphctl scope start ${id}\n`));
      return;
    }

    // Update task status: in_progress → testing → done
    await updateTaskStatus(task.id, 'testing', id);
    console.log(muted('Status updated to: testing'));

    await updateTaskStatus(task.id, 'done', id);
    console.log(success('Status updated to: done'));

    // Log progress
    await logProgress(
      `Completed task: ${task.id} - ${task.name}\n\n` +
        (task.description ? `Description: ${task.description}\n` : '') +
        (task.steps.length > 0
          ? `Steps:\n${task.steps.map((s, i) => `  ${String(i + 1)}. ${s}`).join('\n')}`
          : ''),
      id
    );

    completedCount++;

    // Interactive mode: confirm before continuing
    if (options.interactive && completedCount < targetCount) {
      const remaining = await getRemainingTasks(id);
      if (remaining.length > 0) {
        console.log(info(`\n${String(remaining.length)} task(s) remaining.`));
        const continueLoop = await confirm({
          message: 'Continue to next task?',
          default: true,
        });
        if (!continueLoop) {
          console.log(muted('\nScope paused.'));
          console.log(muted(`Resume with: ralphctl scope start ${id}\n`));
          return;
        }
      }
    }
  }

  // Summary
  const remaining = await getRemainingTasks(id);
  console.log(info('\n=== Summary ==='));
  console.log(info('Completed: ') + String(completedCount) + ' task(s)');
  console.log(info('Remaining: ') + String(remaining.length) + ' task(s)');

  if (await areAllTasksDone(id)) {
    console.log(success('\nAll tasks in scope are done!'));
    const closeScope = await confirm({
      message: 'Close the scope?',
      default: false,
    });
    if (closeScope) {
      console.log(muted(`Run: ralphctl scope close ${id}\n`));
    }
  }

  console.log('');
}
