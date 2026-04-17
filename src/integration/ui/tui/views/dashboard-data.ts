import { getAiProvider, getCurrentSprint } from '@src/integration/persistence/config.ts';
import { getSprint } from '@src/integration/persistence/sprint.ts';
import { getTasks } from '@src/integration/persistence/task.ts';
import { getPendingRequirements } from '@src/integration/persistence/ticket.ts';
import { colors, getQuoteForContext } from '@src/integration/ui/theme/theme.ts';
import { boxChars, emoji, formatSprintStatus, icons, progressBar } from '@src/integration/ui/theme/ui.ts';
import type { Sprint, Tasks } from '@src/domain/models.ts';
import { ensureError, wrapAsync } from '@src/integration/utils/result-helpers.ts';

// ============================================================================
// STATUS DASHBOARD
// ============================================================================

export interface DashboardData {
  sprint: Sprint;
  tasks: Tasks;
  approvedCount: number;
  pendingCount: number;
  blockedCount: number;
  /** Number of tickets that have at least one associated task */
  plannedTicketCount: number;
  /** Current AI provider setting */
  aiProvider: string | null;
}

/**
 * Load dashboard data from the current sprint.
 * Returns null if no current sprint is set.
 */
export async function loadDashboardData(): Promise<DashboardData | null> {
  const sprintId = await getCurrentSprint();
  if (!sprintId) return null;

  const r = await wrapAsync(async () => {
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

    // Count tickets that have at least one associated task
    const ticketIdsWithTasks = new Set(tasks.map((t) => t.ticketId).filter(Boolean));
    const plannedTicketCount = sprint.tickets.filter((t) => ticketIdsWithTasks.has(t.id)).length;

    const aiProvider = await getAiProvider();

    return { sprint, tasks, approvedCount, pendingCount, blockedCount, plannedTicketCount, aiProvider };
  }, ensureError);

  return r.ok ? r.value : null;
}

export interface NextAction {
  label: string;
  description: string;
  group: string;
  subCommand: string;
}

/**
 * Determine the suggested next action based on sprint state.
 */
export function getNextAction(data: DashboardData): NextAction | null {
  const { sprint, tasks, pendingCount, approvedCount } = data;
  const ticketCount = sprint.tickets.length;
  const totalTasks = tasks.length;
  const allDone = totalTasks > 0 && tasks.every((t) => t.status === 'done');

  if (sprint.status === 'draft') {
    if (ticketCount === 0) {
      return { label: 'Add Ticket', description: 'No tickets yet', group: 'ticket', subCommand: 'add' };
    }
    if (pendingCount > 0) {
      return {
        label: 'Refine Requirements',
        description: `${String(pendingCount)} ticket${pendingCount !== 1 ? 's' : ''} pending`,
        group: 'sprint',
        subCommand: 'refine',
      };
    }
    if (approvedCount > 0 && totalTasks === 0) {
      return { label: 'Plan Tasks', description: 'Requirements approved', group: 'sprint', subCommand: 'plan' };
    }
    // Draft with tasks but unplanned tickets — suggest re-plan
    if (totalTasks > 0 && data.plannedTicketCount < ticketCount) {
      const unplanned = ticketCount - data.plannedTicketCount;
      return {
        label: 'Re-Plan Tasks',
        description: `${String(unplanned)} unplanned ticket${unplanned !== 1 ? 's' : ''}`,
        group: 'sprint',
        subCommand: 'plan',
      };
    }
    if (totalTasks > 0) {
      return {
        label: 'Start Sprint',
        description: `${String(totalTasks)} task${totalTasks !== 1 ? 's' : ''} ready`,
        group: 'sprint',
        subCommand: 'start',
      };
    }
  }

  if (sprint.status === 'active') {
    if (allDone) {
      return { label: 'Close Sprint', description: 'All tasks done', group: 'sprint', subCommand: 'close' };
    }
    return {
      label: 'Continue Work',
      description: `${String(totalTasks - tasks.filter((t) => t.status === 'done').length)} task${totalTasks - tasks.filter((t) => t.status === 'done').length !== 1 ? 's' : ''} remaining`,
      group: 'sprint',
      subCommand: 'start',
    };
  }

  return null;
}

/**
 * Render the status dashboard showing current sprint info and task progress.
 * Returns an array of lines to display.
 */
function renderDashboard(data: DashboardData): string[] {
  const { sprint, tasks, approvedCount, blockedCount } = data;
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

  // Ticket requirement status (draft only — not relevant for active/closed)
  if (sprint.status === 'draft' && ticketCount > 0) {
    const refinedColor = approvedCount === ticketCount ? colors.success : colors.warning;
    const refinedPart = refinedColor(`Refined: ${String(approvedCount)}/${String(ticketCount)}`);
    const plannedColor = data.plannedTicketCount === ticketCount ? colors.success : colors.muted;
    const plannedPart = plannedColor(`Planned: ${String(data.plannedTicketCount)}/${String(ticketCount)}`);
    lines.push(`  ${refinedPart}  ${colors.muted('|')}  ${plannedPart}`);
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
      `  ${colors.muted(icons.tip)} ${colors.muted(nextAction.label + ':')} ${colors.highlight(nextAction.description)}`
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
