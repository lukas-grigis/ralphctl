import { getCurrentSprint } from '@src/store/config.ts';
import { getSprint } from '@src/store/sprint.ts';
import { getTasks } from '@src/store/task.ts';
import { colors, getQuoteForContext } from '@src/theme/index.ts';
import { boxChars, emoji, formatSprintStatus, icons } from '@src/theme/ui.ts';
import type { Sprint, Tasks } from '@src/schemas/index.ts';

// ============================================================================
// STATUS DASHBOARD
// ============================================================================

interface DashboardData {
  sprint: Sprint;
  tasks: Tasks;
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
    return { sprint, tasks };
  } catch {
    return null;
  }
}

const DEFAULT_PROGRESS_BAR_WIDTH = 20;

/**
 * Build a progress bar string.
 * @param done - Number of completed items
 * @param total - Total number of items
 * @param width - Width of the bar in characters
 */
function progressBar(done: number, total: number, width = DEFAULT_PROGRESS_BAR_WIDTH): string {
  if (total === 0 || width <= 0) return colors.muted('─'.repeat(Math.max(0, width)));
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  const percent = Math.round((done / total) * 100);

  const bar = colors.success('█'.repeat(filled)) + colors.muted('░'.repeat(empty));
  const label = percent === 100 ? colors.success(`${String(percent)}%`) : colors.muted(`${String(percent)}%`);
  return `${bar} ${label}`;
}

/**
 * Render the status dashboard showing current sprint info and task progress.
 * Returns an array of lines to display.
 */
function renderDashboard(data: DashboardData): string[] {
  const { sprint, tasks } = data;
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
    `  ${colors.muted(icons.tip + ' Get started:')} ${colors.highlight('ralphctl sprint create')}`,
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
