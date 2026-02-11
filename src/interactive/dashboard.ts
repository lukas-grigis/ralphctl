import { getCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { getTasks } from '@src/store/task.ts';
import { getPendingRequirements } from '@src/store/ticket.ts';
import { colors, getQuoteForContext } from '@src/theme/index.ts';
import { boxChars, emoji, formatSprintStatus, icons, progressBar } from '@src/theme/ui.ts';
import type { Sprint, Tasks } from '@src/schemas/index.ts';

// ============================================================================
// STATUS DASHBOARD
// ============================================================================

interface DashboardData {
  sprint: Sprint;
  tasks: Tasks;
  approvedCount: number;
  pendingCount: number;
  blockedCount: number;
}

/**
 * Load dashboard data from the current sprint.
 * Returns null if no current sprint is set.
 */
async function loadDashboardData(): Promise<DashboardData | null> {
  const sprintId = await getCurrentSprint();
  if (!sprintId) return null;

  try {
    const sprint = await getSprint(sprintId);
    const tasks = await getTasks(sprintId);

    const pendingTickets = getPendingRequirements(sprint.tickets);
    const pendingCount = pendingTickets.length;
    const approvedCount = sprint.tickets.length - pendingCount;

    // Count tasks that are blocked (not done, and have unresolved blockers)
    const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const blockedCount = tasks.filter(
      (t) => t.status !== 'done' && t.blockedBy.length > 0 && !t.blockedBy.every((id) => doneIds.has(id))
    ).length;

    return { sprint, tasks, approvedCount, pendingCount, blockedCount };
  } catch {
    return null;
  }
}

/**
 * Determine the suggested next action based on sprint state.
 */
function getNextAction(data: DashboardData): { description: string; command: string } | null {
  const { sprint, tasks, pendingCount, approvedCount } = data;
  const ticketCount = sprint.tickets.length;
  const totalTasks = tasks.length;
  const allDone = totalTasks > 0 && tasks.every((t) => t.status === 'done');

  if (sprint.status === 'draft') {
    if (ticketCount === 0) {
      return { description: 'Add tickets:', command: 'ralphctl ticket add' };
    }
    if (pendingCount > 0) {
      return { description: 'Refine requirements:', command: 'ralphctl sprint refine' };
    }
    if (approvedCount > 0 && totalTasks === 0) {
      return { description: 'Plan tasks:', command: 'ralphctl sprint plan' };
    }
    if (totalTasks > 0) {
      return { description: 'Start sprint:', command: 'ralphctl sprint start' };
    }
  }

  if (sprint.status === 'active') {
    if (allDone) {
      return { description: 'Close sprint:', command: 'ralphctl sprint close' };
    }
    return { description: 'Continue work:', command: 'ralphctl sprint start' };
  }

  return null;
}

/**
 * Render the status dashboard showing current sprint info and task progress.
 * Returns an array of lines to display.
 */
function renderDashboard(data: DashboardData): string[] {
  const { sprint, tasks, approvedCount, pendingCount, blockedCount } = data;
  const chars = boxChars.rounded;

  const todoCount = tasks.filter((t) => t.status === 'todo').length;
  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const totalTasks = tasks.length;
  const ticketCount = sprint.tickets.length;

  // Build content lines
  const lines: string[] = [];

  // Sprint info line
  const sprintLabel = colors.highlight(sprint.name);
  const statusBadge = formatSprintStatus(sprint.status);
  lines.push(`  ${icons.sprint} ${sprintLabel}  ${statusBadge}`);

  // Tickets & tasks summary
  const ticketSummary = `${String(ticketCount)} ticket${ticketCount !== 1 ? 's' : ''}`;
  const taskSummary = `${String(totalTasks)} task${totalTasks !== 1 ? 's' : ''}`;
  lines.push(`  ${colors.muted(`${ticketSummary} ${chars.vertical} ${taskSummary}`)}`);

  // Task progress bar
  if (totalTasks > 0) {
    const bar = progressBar(doneCount, totalTasks);
    const detail = colors.muted(
      `${String(doneCount)} done, ${String(inProgressCount)} active, ${String(todoCount)} todo`
    );
    lines.push(`  ${bar}  ${detail}`);
  }

  // Ticket requirement status
  if (ticketCount > 0) {
    const approvedPart = colors.success(`${String(approvedCount)}/${String(ticketCount)} approved`);
    const pendingPart = pendingCount > 0 ? `  ${colors.warning(`${String(pendingCount)} pending refinement`)}` : '';
    lines.push(`  ${colors.muted('Requirements:')} ${approvedPart}${pendingPart}`);
  }

  // Blocked task alerts
  if (blockedCount > 0) {
    lines.push(
      `  ${colors.warning(icons.warning)} ${colors.warning(`${String(blockedCount)} blocked task${blockedCount !== 1 ? 's' : ''}`)}`
    );
  }

  // Next action suggestion
  const nextAction = getNextAction(data);
  if (nextAction) {
    lines.push(
      `  ${colors.muted(icons.tip)} ${colors.muted(nextAction.description)} ${colors.highlight(nextAction.command)}`
    );
  }

  return lines;
}

/**
 * Render a friendly empty state when no sprint exists.
 */
function renderEmptyDashboard(): string[] {
  const quote = getQuoteForContext('idle');
  return [
    `  ${emoji.donut}  ${colors.muted('No current sprint')}`,
    `  ${colors.muted(`"${quote}"`)}`,
    '',
    `  ${colors.muted(icons.tip)} ${colors.muted('Get started:')}`,
    `    ${colors.muted('1.')} ${colors.muted('Add a project:')}  ${colors.highlight('ralphctl project add')}`,
    `    ${colors.muted('2.')} ${colors.muted('Create a sprint:')} ${colors.highlight('ralphctl sprint create')}`,
  ];
}

/**
 * Display the status dashboard.
 * Shows current sprint info, task progress, and recent activity.
 * Falls back to a friendly empty state when no sprint exists.
 */
export async function showDashboard(): Promise<void> {
  const data = await loadDashboardData();

  console.log('');
  if (data) {
    const lines = renderDashboard(data);
    for (const line of lines) {
      console.log(line);
    }
  } else {
    const lines = renderEmptyDashboard();
    for (const line of lines) {
      console.log(line);
    }
  }
  console.log('');
}

/**
 * Render a compact status line for the persistent header.
 * Returns a single-line string showing sprint context.
 */
export async function getStatusLine(): Promise<string> {
  const data = await loadDashboardData();
  if (!data) {
    return colors.muted(`${emoji.donut} No current sprint`);
  }

  const { sprint, tasks } = data;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  const totalTasks = tasks.length;
  const statusBadge = formatSprintStatus(sprint.status);

  const progress = totalTasks > 0 ? colors.muted(` [${String(doneCount)}/${String(totalTasks)}]`) : '';

  return `${emoji.donut} ${colors.highlight(sprint.name)} ${statusBadge}${progress}`;
}
