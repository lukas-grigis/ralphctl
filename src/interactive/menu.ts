import { Separator } from '@inquirer/prompts';

/**
 * Dynamic context-aware menu system for interactive mode
 */

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
}

/**
 * Build main menu items based on current application state.
 */
export function buildMainMenu(ctx: MenuContext): MenuItem[] {
  const items: MenuItem[] = [];

  // Status is always available
  items.push({
    name: 'Status',
    value: 'status',
    description: 'Current sprint dashboard',
  });

  // Switch Sprint: always available for quick switching
  items.push({
    name: 'Switch Sprint',
    value: 'switch-sprint',
    description: 'Change current sprint',
  });

  // Quick Start: show when no current sprint
  if (!ctx.currentSprintId) {
    items.push({
      name: 'Quick Start',
      value: 'wizard',
      description: 'Guided sprint setup',
    });
  }

  items.push(new Separator());

  items.push({
    name: 'Sprint',
    value: 'sprint',
    description: 'Manage sprints',
  });

  items.push({
    name: 'Ticket',
    value: 'ticket',
    description: 'Manage tickets',
  });

  items.push({
    name: 'Task',
    value: 'task',
    description: 'Manage tasks',
  });

  items.push({ name: 'Progress', value: 'progress', description: 'Log progress' });

  items.push(new Separator());

  items.push({
    name: 'Project',
    value: 'project',
    description: 'Manage projects',
  });

  items.push(new Separator());
  items.push({ name: 'Exit', value: 'exit', description: 'Goodbye!' });

  return items;
}

/**
 * Build sprint submenu based on current sprint state.
 */
function buildSprintSubMenu(ctx: MenuContext): SubMenu {
  const items: MenuItem[] = [];
  const isDraft = ctx.currentSprintStatus === 'draft';
  const isActive = ctx.currentSprintStatus === 'active';

  items.push({ name: 'Create', value: 'create', description: 'Create a new sprint' });
  items.push({ name: 'List', value: 'list', description: 'List all sprints' });
  items.push({ name: 'Show', value: 'show', description: 'Show sprint details' });
  items.push({ name: 'Set Current', value: 'current', description: 'Set current sprint' });
  items.push({ name: 'Context', value: 'context', description: 'Output full sprint context' });

  items.push(new Separator());

  // Workflow actions with state awareness
  items.push({
    name: 'Refine',
    value: 'refine',
    description:
      ctx.pendingRequirements > 0 ? `${String(ctx.pendingRequirements)} tickets pending` : 'Refine ticket requirements',
    disabled: !isDraft ? 'requires draft sprint' : false,
  });

  items.push({
    name: 'Plan',
    value: 'plan',
    description: 'Generate tasks from requirements',
    disabled: !isDraft ? 'requires draft sprint' : !ctx.allRequirementsApproved ? 'refine requirements first' : false,
  });

  items.push({
    name: 'Export Requirements',
    value: 'requirements',
    description: 'Export refined requirements to file',
  });

  items.push(new Separator());

  items.push({
    name: 'Start',
    value: 'start',
    description: 'Start implementation',
    disabled: !isDraft && !isActive ? 'requires draft or active sprint' : false,
  });

  items.push({
    name: 'Health',
    value: 'health',
    description: 'Check sprint health',
  });

  items.push({
    name: 'Close',
    value: 'close',
    description: 'Close sprint',
    disabled: !isActive ? 'requires active sprint' : false,
  });

  items.push({
    name: 'Delete',
    value: 'delete',
    description: 'Delete a sprint permanently',
  });

  items.push(new Separator());
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  return { title: 'Sprint', items };
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
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a ticket' });
  items.push(new Separator());
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  return { title: 'Ticket', items };
}

/**
 * Build task submenu.
 */
function buildTaskSubMenu(): SubMenu {
  const items: MenuItem[] = [];

  items.push({ name: 'Add', value: 'add', description: 'Add a new task' });
  items.push({ name: 'Import', value: 'import', description: 'Import from JSON' });
  items.push({ name: 'List', value: 'list', description: 'List all tasks' });
  items.push({ name: 'Show', value: 'show', description: 'Show task details' });
  items.push(new Separator());
  items.push({ name: 'Status', value: 'status', description: 'Update status' });
  items.push({ name: 'Next', value: 'next', description: 'Get next task' });
  items.push({ name: 'Reorder', value: 'reorder', description: 'Change priority' });
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a task' });
  items.push(new Separator());
  items.push({ name: 'Back', value: 'back', description: 'Return to main menu' });

  return { title: 'Task', items };
}

/**
 * Build progress submenu.
 */
function buildProgressSubMenu(): SubMenu {
  const items: MenuItem[] = [];

  items.push({ name: 'Log', value: 'log', description: 'Log progress entry' });
  items.push({ name: 'Show', value: 'show', description: 'Show progress log' });
  items.push(new Separator());
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
  items.push({ name: 'Remove', value: 'remove', description: 'Remove a project' });
  items.push(new Separator());
  items.push({
    name: 'Add Repository',
    value: 'repo add',
    description: 'Add repository to project',
  });
  items.push({ name: 'Remove Repository', value: 'repo remove', description: 'Remove repository' });
  items.push(new Separator());
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
      return buildTaskSubMenu();
    case 'progress':
      return buildProgressSubMenu();
    case 'project':
      return buildProjectSubMenu();
    default:
      return null;
  }
}
