import { Separator } from '@inquirer/prompts';
import { colors } from '@src/theme/index.ts';
import type { NextAction } from './dashboard.ts';

/**
 * Dynamic context-aware menu system for interactive mode
 */

const SEPARATOR_WIDTH = 48;

/** Create a titled separator: ── LABEL ──────────── */
function titled(label: string): SeparatorInstance {
  const lineLen = Math.max(2, SEPARATOR_WIDTH - label.length - 4); // 4 = "── " + " "
  return new Separator(colors.muted(`\n── ${label} ${'─'.repeat(lineLen)}`));
}

/** Plain line separator: ────────────────────────── */
function line(): SeparatorInstance {
  return new Separator(colors.muted('─'.repeat(SEPARATOR_WIDTH)));
}

interface Choice {
  name: string;
  value: string;
  description?: string;
  disabled?: string | boolean;
}

type SeparatorInstance = InstanceType<typeof Separator>;

export type MenuItem = Choice | SeparatorInstance;

export interface SubMenu {
  title: string;
  items: MenuItem[];
}

/** Sprint/ticket/task counts for menu context */
export interface MenuContext {
  hasProjects: boolean;
  projectCount: number;
  currentSprintId: string | null;
  currentSprintName: string | null;
  currentSprintStatus: 'draft' | 'active' | 'closed' | null;
  ticketCount: number;
  taskCount: number;
  tasksDone: number;
  tasksInProgress: number;
  pendingRequirements: number;
  allRequirementsApproved: boolean;
  /** Number of tickets that have at least one associated task */
  plannedTicketCount: number;
  nextAction: NextAction | null;
}

// ============================================================================
// WORKFLOW ACTIONS — actions that advance sprint state
// ============================================================================

const WORKFLOW_ACTIONS: Record<string, Set<string>> = {
  sprint: new Set(['create', 'refine', 'ideate', 'plan', 'start', 'close']),
  ticket: new Set(['add']),
  task: new Set(['add', 'import']),
};

/**
 * Check if a command is a workflow action that should return to main menu.
 */
export function isWorkflowAction(group: string, subCommand: string): boolean {
  return WORKFLOW_ACTIONS[group]?.has(subCommand) ?? false;
}

/**
 * Build workflow actions in sprint lifecycle order with disable logic.
 */
function buildWorkflowActions(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];
  const isDraft = ctx.currentSprintStatus === 'draft';
  const isActive = ctx.currentSprintStatus === 'active';
  const hasSprint = ctx.currentSprintId !== null;

  // Create Sprint — always available
  items.push({ name: 'Create Sprint', value: 'action:sprint:create', description: 'Start a new sprint' });

  // Add Ticket — requires draft sprint + projects
  const addTicketDisabled = !hasSprint
    ? 'create a sprint first'
    : !isDraft
      ? 'need draft sprint'
      : !ctx.hasProjects
        ? 'add a project first'
        : false;
  items.push({
    name: 'Add Ticket',
    value: 'action:ticket:add',
    description: 'Add work to current sprint',
    disabled: addTicketDisabled,
  });

  // Refine Requirements — requires draft sprint + pending tickets
  let refineDisabled: string | false = false;
  let refineDesc = 'Clarify ticket requirements';
  if (!hasSprint) {
    refineDisabled = 'create a sprint first';
  } else if (!isDraft) {
    refineDisabled = 'need draft sprint';
  } else if (ctx.ticketCount === 0) {
    refineDisabled = 'add tickets first';
  } else if (ctx.pendingRequirements === 0) {
    refineDisabled = 'all tickets refined';
  } else {
    refineDesc = `${String(ctx.pendingRequirements)} ticket${ctx.pendingRequirements !== 1 ? 's' : ''} pending`;
  }
  items.push({
    name: 'Refine Requirements',
    value: 'action:sprint:refine',
    description: refineDesc,
    disabled: refineDisabled,
  });

  // Plan Tasks — requires draft + all requirements approved
  let planDisabled: string | false = false;
  if (!hasSprint) {
    planDisabled = 'create a sprint first';
  } else if (!isDraft) {
    planDisabled = 'need draft sprint';
  } else if (ctx.ticketCount === 0) {
    planDisabled = 'add tickets first';
  } else if (!ctx.allRequirementsApproved) {
    planDisabled = 'refine all tickets first';
  }
  items.push({
    name: 'Plan Tasks',
    value: 'action:sprint:plan',
    description: 'Generate tasks from requirements',
    disabled: planDisabled,
  });

  // Ideate — requires draft + projects
  const ideateDisabled = !hasSprint
    ? 'create a sprint first'
    : !isDraft
      ? 'need draft sprint'
      : !ctx.hasProjects
        ? 'add a project first'
        : false;
  items.push({
    name: 'Ideate',
    value: 'action:sprint:ideate',
    description: 'Quick idea to tasks',
    disabled: ideateDisabled,
  });

  // Start Sprint — requires draft/active + tasks
  let startDisabled: string | false = false;
  if (!hasSprint) {
    startDisabled = 'create a sprint first';
  } else if (!isDraft && !isActive) {
    startDisabled = 'need draft or active sprint';
  } else if (ctx.taskCount === 0) {
    startDisabled = 'plan tasks first';
  }
  items.push({
    name: 'Start Sprint',
    value: 'action:sprint:start',
    description: 'Begin implementation',
    disabled: startDisabled,
  });

  // Health Check — requires a sprint
  items.push({
    name: 'Health Check',
    value: 'action:sprint:health',
    description: 'Diagnose blockers and stale tasks',
    disabled: !hasSprint ? 'no sprint' : false,
  });

  // Close Sprint — requires active sprint
  items.push({
    name: 'Close Sprint',
    value: 'action:sprint:close',
    description: 'Close the current sprint',
    disabled: !isActive ? 'need active sprint' : false,
  });

  return items;
}

/**
 * Build main menu items based on current application state.
 */
export function buildMainMenu(ctx: MenuContext): { items: MenuItem[]; defaultValue?: string } {
  const items: MenuItem[] = [];

  // Next action — first item, default selection
  let defaultValue: string | undefined;
  if (ctx.nextAction) {
    const actionValue = `action:${ctx.nextAction.group}:${ctx.nextAction.subCommand}`;
    items.push({
      name: `\u2192 ${ctx.nextAction.label}`,
      value: actionValue,
      description: ctx.nextAction.description,
    });
    defaultValue = actionValue;
  }

  // Workflow section — flat lifecycle-ordered actions
  items.push(titled('WORKFLOW'));
  for (const action of buildWorkflowActions(ctx)) {
    items.push(action);
  }

  // Browse & manage submenus
  items.push(titled('BROWSE & MANAGE'));
  items.push({ name: 'Sprints', value: 'sprint', description: 'List, show, switch, delete' });
  items.push({ name: 'Tickets', value: 'ticket', description: 'List, show, edit, remove' });
  items.push({ name: 'Tasks', value: 'task', description: 'List, show, add, status, reorder' });
  items.push({ name: 'Projects', value: 'project', description: 'List, show, add, remove' });
  items.push({ name: 'Progress', value: 'progress', description: 'Log and view progress' });

  // Utilities
  items.push(line());
  if (!ctx.currentSprintId) {
    items.push({ name: 'Quick Start Wizard', value: 'wizard', description: 'Guided sprint setup' });
  }
  items.push({ name: 'Status Dashboard', value: 'status', description: 'Full sprint overview' });
  items.push({ name: 'Exit', value: 'exit', description: 'Goodbye!' });

  return { items, defaultValue };
}

/**
 * Build sprint submenu — browse/manage only (workflow actions are in main menu).
 */
function buildSprintSubMenu(ctx: MenuContext): SubMenu {
  const items: MenuItem[] = [];

  items.push(titled('BROWSE'));
  items.push({ name: 'List', value: 'list', description: 'List all sprints' });
  items.push({ name: 'Show', value: 'show', description: 'Show sprint details' });
  items.push({ name: 'Set Current', value: 'current', description: 'Set current sprint' });
  items.push({ name: 'Context', value: 'context', description: 'Output full sprint context' });
  items.push({
    name: 'Export Requirements',
    value: 'requirements',
    description: 'Export refined requirements to file',
  });
  items.push(line());
  items.push({ name: 'Delete', value: 'delete', description: 'Delete a sprint permanently' });
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  const titleSuffix = ctx.currentSprintName
    ? ` \u2014 ${ctx.currentSprintName} (${ctx.currentSprintStatus ?? 'unknown'})`
    : '';
  return { title: `Sprint${titleSuffix}`, items };
}

/**
 * Build ticket submenu with state-aware descriptions.
 */
function buildTicketSubMenu(ctx: MenuContext): SubMenu {
  const items: MenuItem[] = [];

  items.push({
    name: 'Add',
    value: 'add',
    description: ctx.hasProjects ? 'Add a ticket' : 'Add a ticket (add a project first)',
    disabled: !ctx.hasProjects ? 'add a project first' : false,
  });
  items.push({ name: 'Edit', value: 'edit', description: 'Edit a ticket' });
  items.push({ name: 'List', value: 'list', description: 'List all tickets' });
  items.push({ name: 'Show', value: 'show', description: 'Show ticket details' });
  items.push(line());
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a ticket' });
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  const titleSuffix = ctx.currentSprintName ? ` \u2014 ${ctx.currentSprintName}` : '';
  return { title: `Ticket${titleSuffix}`, items };
}

/**
 * Build task submenu.
 */
function buildTaskSubMenu(ctx: MenuContext): SubMenu {
  const items: MenuItem[] = [];

  items.push(titled('VIEW'));
  items.push({ name: 'List', value: 'list', description: 'List all tasks' });
  items.push({ name: 'Show', value: 'show', description: 'Show task details' });
  items.push({ name: 'Next', value: 'next', description: 'Get next task' });
  items.push(titled('MANAGE'));
  items.push({ name: 'Add', value: 'add', description: 'Add a new task' });
  items.push({ name: 'Import', value: 'import', description: 'Import from JSON' });
  items.push({ name: 'Status', value: 'status', description: 'Update status' });
  items.push({ name: 'Reorder', value: 'reorder', description: 'Change priority' });
  items.push(line());
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a task' });
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  const titleSuffix = ctx.currentSprintName ? ` \u2014 ${ctx.currentSprintName}` : '';
  return { title: `Task${titleSuffix}`, items };
}

/**
 * Build progress submenu.
 */
function buildProgressSubMenu(): SubMenu {
  const items: MenuItem[] = [];

  items.push({ name: 'Log', value: 'log', description: 'Log progress entry' });
  items.push({ name: 'Show', value: 'show', description: 'Show progress log' });
  items.push(line());
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  return { title: 'Progress', items };
}

/**
 * Build project submenu.
 */
function buildProjectSubMenu(): SubMenu {
  const items: MenuItem[] = [];

  items.push({ name: 'Add', value: 'add', description: 'Add a new project' });
  items.push({ name: 'List', value: 'list', description: 'List all projects' });
  items.push({ name: 'Show', value: 'show', description: 'Show project details' });
  items.push(titled('REPOSITORIES'));
  items.push({
    name: 'Add Repository',
    value: 'repo add',
    description: 'Add repository to project',
  });
  items.push({ name: 'Remove Repository', value: 'repo remove', description: 'Remove repository' });
  items.push(line());
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a project' });
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  return { title: 'Project', items };
}

/**
 * Build a submenu by group name with full context.
 */
export function buildSubMenu(group: string, ctx: MenuContext): SubMenu | null {
  switch (group) {
    case 'sprint':
      return buildSprintSubMenu(ctx);
    case 'ticket':
      return buildTicketSubMenu(ctx);
    case 'task':
      return buildTaskSubMenu(ctx);
    case 'progress':
      return buildProgressSubMenu();
    case 'project':
      return buildProjectSubMenu();
    default:
      return null;
  }
}
