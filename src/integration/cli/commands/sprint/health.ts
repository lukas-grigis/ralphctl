import { Result } from 'typescript-result';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';
import { getCurrentSprintOrThrow } from '@src/integration/persistence/sprint.ts';
import { getTasks } from '@src/integration/persistence/task.ts';
import { colors, getQuoteForContext } from '@src/integration/ui/theme/theme.ts';
import { icons, log, printHeader, progressBar, renderCard, showError } from '@src/integration/ui/theme/ui.ts';
import type { Sprint, Task } from '@src/domain/models.ts';
import { getCurrentBranch } from '@src/integration/external/git.ts';
import { resolveRepoPath } from '@src/integration/persistence/project.ts';

// ============================================================================
// Health Check Types
// ============================================================================

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  items: string[];
}

// ============================================================================
// Health Check Runners
// ============================================================================

function checkBlockers(tasks: Task[]): HealthCheck {
  const doneTasks = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const allTaskIds = new Set(tasks.map((t) => t.id));

  const blocked: string[] = [];
  for (const task of tasks) {
    if (task.status === 'done') continue;
    const unresolvedDeps = task.blockedBy.filter((depId) => allTaskIds.has(depId) && !doneTasks.has(depId));
    if (unresolvedDeps.length > 0) {
      blocked.push(`${task.name} ${colors.muted(`(${task.id})`)} blocked by ${unresolvedDeps.join(', ')}`);
    }
  }

  return {
    name: 'Blockers',
    status: blocked.length > 0 ? 'fail' : 'pass',
    items: blocked,
  };
}

function checkStaleTasks(tasks: Task[]): HealthCheck {
  const stale = tasks.filter((t) => t.status === 'in_progress');
  const items = stale.map((t) => `${t.name} ${colors.muted(`(${t.id})`)}`);

  return {
    name: 'Stale Tasks',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

function checkOrphanedDeps(tasks: Task[]): HealthCheck {
  const allTaskIds = new Set(tasks.map((t) => t.id));
  const orphaned: string[] = [];

  for (const task of tasks) {
    const missingDeps = task.blockedBy.filter((depId) => !allTaskIds.has(depId));
    if (missingDeps.length > 0) {
      orphaned.push(`${task.name} ${colors.muted(`(${task.id})`)} references missing: ${missingDeps.join(', ')}`);
    }
  }

  return {
    name: 'Orphaned Dependencies',
    status: orphaned.length > 0 ? 'fail' : 'pass',
    items: orphaned,
  };
}

function checkTicketsWithoutTasks(sprint: Sprint, tasks: Task[]): HealthCheck {
  const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
  const orphanedTickets = sprint.tickets.filter((t) => !ticketIdsWithTasks.has(t.id));
  const items = orphanedTickets.map((t) => `${t.title} ${colors.muted(`(${t.id})`)}`);

  return {
    name: 'Tickets Without Tasks',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

function checkDuplicateOrders(tasks: Task[]): HealthCheck {
  const orderCounts = new Map<number, string[]>();
  for (const task of tasks) {
    const existing = orderCounts.get(task.order) ?? [];
    existing.push(`${task.name} ${colors.muted(`(${task.id})`)}`);
    orderCounts.set(task.order, existing);
  }

  const items: string[] = [];
  for (const [order, taskNames] of orderCounts) {
    if (taskNames.length > 1) {
      items.push(`Order ${String(order)}: ${taskNames.join(', ')}`);
    }
  }

  return {
    name: 'Duplicate Task Orders',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

function checkPendingRequirementsOnActive(sprint: Sprint): HealthCheck {
  if (sprint.status !== 'active') {
    return { name: 'Pending Requirements', status: 'pass', items: [] };
  }

  const pending = sprint.tickets.filter((t) => t.requirementStatus === 'pending');
  const items = pending.map((t) => `${t.title} ${colors.muted(`(${t.id})`)} — refine before planning`);

  return {
    name: 'Pending Requirements',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

async function checkBranchConsistency(sprint: Sprint, tasks: Task[]): Promise<HealthCheck> {
  if (!sprint.branch) {
    return { name: 'Branch Consistency', status: 'pass', items: [] };
  }

  const remainingTasks = tasks.filter((t) => t.status !== 'done');
  const uniqueRepoIds = [...new Set(remainingTasks.map((t) => t.repoId))];
  const items: string[] = [];

  for (const repoId of uniqueRepoIds) {
    const path = await resolveRepoPath(repoId).catch(() => null);
    if (!path) {
      items.push(`${repoId} — repo path could not be resolved`);
      continue;
    }
    const branchR = Result.try(() => getCurrentBranch(path));
    if (!branchR.ok) {
      items.push(`${path} — unable to determine branch`);
    } else if (branchR.value !== sprint.branch) {
      items.push(`${path} — on '${branchR.value}', expected '${sprint.branch}'`);
    }
  }

  return {
    name: 'Branch Consistency',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

function checkTasksWithoutSteps(tasks: Task[]): HealthCheck {
  const empty = tasks.filter((t) => t.steps.length === 0);
  const items = empty.map((t) => `${t.name} ${colors.muted(`(${t.id})`)}`);

  return {
    name: 'Tasks Without Steps',
    status: items.length > 0 ? 'warn' : 'pass',
    items,
  };
}

// ============================================================================
// Card Rendering
// ============================================================================

function renderCheckCard(check: HealthCheck): string {
  const colorFn = check.status === 'pass' ? colors.success : check.status === 'warn' ? colors.warning : colors.error;

  const statusIcon = check.status === 'pass' ? icons.success : check.status === 'warn' ? icons.warning : icons.error;

  const lines: string[] = [];

  if (check.items.length === 0) {
    lines.push(colors.success(`${icons.success} No issues found`));
  } else {
    for (const item of check.items) {
      lines.push(`${colorFn(statusIcon)} ${item}`);
    }
  }

  return renderCard(check.name, lines, { colorFn });
}

// ============================================================================
// Main Command
// ============================================================================

export async function sprintHealthCommand(): Promise<void> {
  const sprintR = await wrapAsync(() => getCurrentSprintOrThrow(), ensureError);
  if (!sprintR.ok) {
    showError(sprintR.error.message);
    return;
  }
  const sprint: Sprint = sprintR.value;

  const tasks = await getTasks(sprint.id);

  printHeader(`Sprint Health: ${sprint.name}`, icons.sprint);

  const checks: HealthCheck[] = [
    checkBlockers(tasks),
    checkStaleTasks(tasks),
    checkOrphanedDeps(tasks),
    checkTicketsWithoutTasks(sprint, tasks),
    checkTasksWithoutSteps(tasks),
    checkDuplicateOrders(tasks),
    checkPendingRequirementsOnActive(sprint),
    await checkBranchConsistency(sprint, tasks),
  ];

  for (const check of checks) {
    console.log(renderCheckCard(check));
    log.newline();
  }

  // Health score
  const passing = checks.filter((c) => c.status === 'pass').length;
  const total = checks.length;
  const bar = progressBar(passing, total);
  log.info(`Health Score: ${bar}  ${colors.muted(`${String(passing)}/${String(total)} checks passing`)}`);

  // Ralph quote
  log.newline();
  const category = passing === total ? 'success' : 'error';
  const quote = getQuoteForContext(category);
  console.log(colors.muted(`  "${quote}"`));
  log.newline();
}
