import { colors } from '@src/integration/ui/theme/theme.ts';
import type { NextAction } from './dashboard-data.ts';

/**
 * Submenu builders for Home's secondary entry points.
 *
 * Home's primary surface is the pipeline map (see `pipeline-phases.ts`). This
 * module supplies the submenu shapes that Home reaches via hotkey — `b` opens
 * the browse menu, which may drill into the sprint/ticket/task/project/config
 * submenus. Each submenu is a plain data structure; rendering lives in
 * `components/action-menu.tsx`.
 *
 * Top-level workflow actions (Create Sprint, Refine Requirements, Plan, Start,
 * Close) do not belong here — they're computed by `pipeline-phases.ts` and
 * fired by the pipeline map. This module handles everything else.
 */

const SEPARATOR_WIDTH = 48;

/**
 * Separator item — purely visual. Rendered as a disabled, non-selectable entry
 * by `escapableSelect`. Using a plain shape keeps menu construction free of
 * UI-library dependencies.
 */
export interface MenuSeparator {
  separator: string;
}

function isSeparator(item: MenuItem): item is MenuSeparator {
  return 'separator' in item;
}

/** Create a titled separator: ── LABEL ──────────── */
function titled(label: string): MenuSeparator {
  const lineLen = Math.max(2, SEPARATOR_WIDTH - label.length - 4); // 4 = "── " + " "
  return { separator: colors.muted(`\n── ${label} ${'─'.repeat(lineLen)}`) };
}

/** Plain line separator: ────────────────────────── */
function line(): MenuSeparator {
  return { separator: colors.muted('─'.repeat(SEPARATOR_WIDTH)) };
}

interface Choice {
  name: string;
  value: string;
  description?: string;
  disabled?: string | boolean;
}

export type MenuItem = Choice | MenuSeparator;

export { isSeparator };

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
  /** Current AI provider setting */
  aiProvider: string | null;
}

/**
 * Build the browse menu — the single secondary hub reached via `b` from Home.
 *
 * Entries fall into two buckets:
 *   - `group:<name>` — transitions Home into that group's submenu (sprint,
 *     ticket, task, project, config).
 *   - `action:<group>:<sub>` — runs a command directly (doctor, progress show).
 *
 * Home's submenu dispatcher recognises both prefixes.
 */
export function buildBrowseMenu(): SubMenu {
  const items: MenuItem[] = [];
  items.push(titled('BROWSE'));
  items.push({ name: 'Sprints', value: 'group:sprint', description: 'List, show, manage sprints' });
  items.push({ name: 'Tickets', value: 'group:ticket', description: 'List, show, edit tickets' });
  items.push({ name: 'Tasks', value: 'group:task', description: 'List, show, manage tasks' });
  items.push({ name: 'Projects', value: 'group:project', description: 'Manage projects & repositories' });
  items.push({ name: 'Progress', value: 'action:progress:show', description: 'View progress log' });
  items.push(titled('SETUP'));
  // Configuration lives behind the global `s` hotkey (StatusBar) — don't
  // duplicate it here as a menu entry.
  items.push({ name: 'Doctor', value: 'action:doctor:run', description: 'Check environment health' });
  items.push(line());
  items.push({ name: 'Back', value: 'back', description: 'Return to Home' });
  return { title: 'Browse & Setup', items };
}

/**
 * Build sprint submenu. The pipeline map surfaces the next *relevant* workflow
 * action (Create Sprint / Add Ticket / …) on Home, but the user may want to
 * create an additional sprint while one is already current — so Create lives
 * here too, unconditionally.
 */
function buildSprintSubMenu(ctx: MenuContext): SubMenu {
  const items: MenuItem[] = [];

  items.push(titled('NEW'));
  items.push({ name: 'Create', value: 'create', description: 'Create a new sprint' });
  items.push(titled('BROWSE'));
  items.push({ name: 'List', value: 'list', description: 'List all sprints' });
  items.push({ name: 'Show', value: 'show', description: 'Show sprint details' });
  items.push({ name: 'Set Current', value: 'current', description: 'Set current sprint' });
  items.push(titled('EXPORT'));
  items.push({
    name: 'Requirements',
    value: 'requirements',
    description: 'Export refined requirements',
  });
  items.push({ name: 'Context', value: 'context', description: 'Output full sprint context' });
  items.push({ name: 'Progress', value: 'progress show', description: 'View progress log' });
  items.push(titled('MANAGE'));
  items.push({ name: 'Log Progress', value: 'progress log', description: 'Add progress entry' });
  items.push({ name: 'Delete', value: 'delete', description: 'Delete a sprint permanently' });
  items.push(line());
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

  // Re-refine — requires draft sprint with approved tickets
  const approvedCount = ctx.ticketCount - ctx.pendingRequirements;
  let refineDisabled: string | false = false;
  if (ctx.currentSprintStatus !== 'draft') {
    refineDisabled = 'need draft sprint';
  } else if (approvedCount === 0) {
    refineDisabled = 'no approved tickets';
  }
  items.push({
    name: 'Refine',
    value: 'refine',
    description: 'Re-refine approved requirements',
    disabled: refineDisabled,
  });

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
 * Build project submenu.
 */
function buildProjectSubMenu(): SubMenu {
  const items: MenuItem[] = [];

  items.push({ name: 'Add', value: 'add', description: 'Add a new project' });
  items.push({ name: 'Edit', value: 'edit', description: 'Rename display name / edit description' });
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
 * Build a submenu by group name with full context. Configuration isn't in
 * here — the global `s` hotkey opens the settings panel directly, so the
 * submenu path would be a second, duplicate entry point.
 */
export function buildSubMenu(group: string, ctx: MenuContext): SubMenu | null {
  switch (group) {
    case 'sprint':
      return buildSprintSubMenu(ctx);
    case 'ticket':
      return buildTicketSubMenu(ctx);
    case 'task':
      return buildTaskSubMenu(ctx);
    case 'project':
      return buildProjectSubMenu();
    case 'browse':
      return buildBrowseMenu();
    default:
      return null;
  }
}
