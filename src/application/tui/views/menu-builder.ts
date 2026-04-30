/**
 * Submenu builders for Home's secondary entry points.
 *
 * Home's primary surface is the pipeline map (see `pipeline-phases.ts`). This
 * module supplies the submenu shapes that Home reaches via the `b` hotkey.
 * Each submenu is a plain data structure; rendering lives in
 * `components/action-menu.tsx`.
 *
 * Top-level workflow actions (Create Sprint, Refine Requirements, Plan, Start,
 * Close) do not belong here — they're computed by `pipeline-phases.ts` and
 * fired by the pipeline map. This module handles everything else.
 *
 * Every choice carries a typed `MenuAction` (see `menu-action.ts`). No more
 * `action:<group>:<sub>` / `group:<name>` string parsing — the dispatcher
 * switches on `action.kind`.
 */

// Re-export MenuContext from pipeline-phases so callers only need one import.
export type { MenuContext } from '../pipeline-phases.ts';
import type { MenuContext } from '../pipeline-phases.ts';
import type { MenuAction } from './menu-action.ts';

/**
 * A purely visual separator row. Rendered as a non-selectable label line
 * by `ActionMenu`. No UI-library imports here — this module is pure data.
 */
export interface MenuSeparator {
  readonly separator: string;
}

export interface Choice {
  readonly name: string;
  readonly action: MenuAction;
  readonly description?: string;
  readonly disabled?: string | boolean;
}

export type MenuItem = Choice | MenuSeparator;

export function isSeparator(item: MenuItem): item is MenuSeparator {
  return 'separator' in item;
}

export interface SubMenu {
  readonly title: string;
  readonly items: MenuItem[];
}

// ── private helpers ──────────────────────────────────────────────────────────

function sep(label?: string): MenuSeparator {
  return { separator: label ?? '' };
}

const BACK: MenuAction = { kind: 'back' };

// ── browse menu ──────────────────────────────────────────────────────────────

/**
 * Top-level browse menu — the single secondary hub reached via `b` from Home.
 * Routes go straight to list views; project/ticket/etc. group entries drill
 * into a submenu.
 */
export function buildBrowseMenu(ctx: MenuContext): SubMenu {
  const hasCurrent = ctx.currentSprintId !== null;
  const currentHeader = ctx.currentSprintName ? `Current Sprint: ${ctx.currentSprintName}` : 'Current Sprint';

  const items: MenuItem[] = [
    sep(currentHeader),
    {
      name: 'Tickets',
      action: { kind: 'subMenu', group: 'ticket' },
      description: 'Add / edit / approve / refine tickets',
      disabled: hasCurrent ? false : 'no current sprint',
    },
    {
      name: 'Tasks',
      action: { kind: 'subMenu', group: 'task' },
      description: 'Add / edit / status / remove tasks',
      disabled: hasCurrent ? false : 'no current sprint',
    },
    sep(),
    sep('Across Sprints'),
    {
      name: 'Sprints',
      action: { kind: 'subMenu', group: 'sprint' },
      description: 'Create / edit / activate / close / PR',
    },
    { name: 'Projects', action: { kind: 'subMenu', group: 'project' }, description: 'Add / edit / repos / onboard' },
    sep(),
    sep('System'),
    {
      name: 'Onboard a repo',
      action: { kind: 'launchChain', flow: 'onboard' },
      description: 'AI-assisted setup: scripts + project context file',
      disabled: ctx.hasProjects ? false : 'add a project first',
    },
    { name: 'Doctor', action: { kind: 'route', viewId: 'doctor' }, description: 'Check environment health' },
    sep(),
    { name: 'Back', action: BACK, description: 'Return to Home' },
  ];

  return { title: 'Browse', items };
}

// ── sprint submenu ───────────────────────────────────────────────────────────

function buildSprintSubMenu(ctx: MenuContext): SubMenu {
  const titleSuffix = ctx.currentSprintName
    ? ` — ${ctx.currentSprintName} (${ctx.currentSprintStatus ?? 'unknown'})`
    : '';

  let createPrDisabled: string | false;
  if (!ctx.currentSprintHasBranch) {
    createPrDisabled = 'sprint has no branch';
  } else if (ctx.currentSprintHasPullRequest) {
    createPrDisabled = 'pr already created';
  } else {
    createPrDisabled = false;
  }

  const hasCurrent = ctx.currentSprintId !== null;
  const isClosed = ctx.currentSprintStatus === 'closed';
  const isDraft = ctx.currentSprintStatus === 'draft';
  const editDisabled: string | false = !hasCurrent ? 'no current sprint' : isClosed ? 'sprint is closed' : false;
  const activateDisabled: string | false = !hasCurrent
    ? 'no current sprint'
    : !isDraft
      ? 'only draft sprints can be activated'
      : false;

  const exportDisabled: string | false = !hasCurrent ? 'no current sprint' : false;

  const items: MenuItem[] = [
    sep('NEW'),
    { name: 'Create', action: { kind: 'route', viewId: 'sprint-create' }, description: 'Create a new sprint' },
    sep(),
    sep('BROWSE'),
    { name: 'List', action: { kind: 'route', viewId: 'sprint-list' }, description: 'List all sprints' },
    {
      name: 'Progress',
      action: { kind: 'route', viewId: 'progress' },
      description: 'Timeline + blockers + stale + cycles + branch',
      disabled: !hasCurrent ? 'no current sprint' : false,
    },
    sep(),
    sep('EXPORT'),
    {
      name: 'Requirements',
      action: { kind: 'route', viewId: 'sprint-export-requirements' },
      description: 'Write refined requirements to markdown',
      disabled: exportDisabled,
    },
    {
      name: 'Context',
      action: { kind: 'route', viewId: 'sprint-export-context' },
      description: 'Write full harness context to markdown',
      disabled: exportDisabled,
    },
    sep(),
    sep('EDIT'),
    {
      name: 'Edit current',
      action: { kind: 'route', viewId: 'sprint-edit' },
      description: 'Rename or change branch',
      disabled: editDisabled,
    },
    {
      name: 'Set as current',
      action: { kind: 'route', viewId: 'sprint-set-current' },
      description: 'Pick which sprint commands target',
    },
    {
      name: 'Activate',
      action: { kind: 'route', viewId: 'sprint-activate' },
      description: 'Move draft → active',
      disabled: activateDisabled,
    },
    sep(),
    sep('PUBLISH'),
    {
      name: 'Create PR / MR',
      action: { kind: 'launchChain', flow: 'create-pr' },
      description: 'Open a pull/merge request from the sprint branch',
      disabled: createPrDisabled,
    },
    sep(),
    sep('MANAGE'),
    {
      name: 'Remove',
      action: { kind: 'route', viewId: 'sprint-remove' },
      description: 'Remove a sprint permanently',
    },
    sep(),
    { name: 'Back', action: BACK, description: 'Return to Browse' },
  ];

  return { title: `Sprint${titleSuffix}`, items };
}

// ── ticket submenu ───────────────────────────────────────────────────────────

function buildTicketSubMenu(ctx: MenuContext): SubMenu {
  const approvedCount = ctx.ticketCount - ctx.pendingRequirements;

  let refineDisabled: string | false = false;
  if (ctx.currentSprintStatus !== 'draft') {
    refineDisabled = 'need draft sprint';
  } else if (approvedCount === 0) {
    refineDisabled = 'no approved tickets';
  }

  const hasTickets = ctx.ticketCount > 0;
  const editDisabledReason: string | false = !hasTickets ? 'no tickets' : false;
  const approveDisabledReason: string | false = !hasTickets
    ? 'no tickets'
    : ctx.pendingRequirements === 0
      ? 'no pending tickets'
      : false;

  const titleSuffix = ctx.currentSprintName ? ` — ${ctx.currentSprintName}` : '';

  const items: MenuItem[] = [
    sep('NEW'),
    {
      name: 'Add',
      action: { kind: 'route', viewId: 'ticket-add' },
      description: ctx.hasProjects ? 'Add a ticket to the sprint' : 'Add a ticket (add a project first)',
      disabled: !ctx.hasProjects ? 'add a project first' : false,
    },
    sep(),
    sep('BROWSE'),
    { name: 'List', action: { kind: 'route', viewId: 'ticket-list' }, description: 'List all tickets' },
    sep(),
    sep('EDIT'),
    {
      name: 'Edit',
      action: { kind: 'route', viewId: 'ticket-edit' },
      description: 'Edit ticket title / description / link',
      disabled: editDisabledReason,
    },
    {
      name: 'Approve requirements',
      action: { kind: 'route', viewId: 'ticket-approve' },
      description: 'Manually approve a pending ticket',
      disabled: approveDisabledReason,
    },
    {
      name: 'Assign repositories',
      action: { kind: 'route', viewId: 'ticket-assign-repos' },
      description: 'Pick which repos a ticket affects',
      disabled: editDisabledReason,
    },
    {
      name: 'Refine',
      action: { kind: 'launchChain', flow: 'refine' },
      description: 'Re-refine approved requirements',
      disabled: refineDisabled,
    },
    sep(),
    sep('MANAGE'),
    { name: 'Remove', action: { kind: 'route', viewId: 'ticket-remove' }, description: 'Remove a ticket' },
    sep(),
    { name: 'Back', action: BACK, description: 'Return to Browse' },
  ];

  return { title: `Ticket${titleSuffix}`, items };
}

// ── task submenu ─────────────────────────────────────────────────────────────

function buildTaskSubMenu(ctx: MenuContext): SubMenu {
  const titleSuffix = ctx.currentSprintName ? ` — ${ctx.currentSprintName}` : '';
  const hasTasks = ctx.taskCount > 0;
  const editDisabledReason: string | false = !hasTasks ? 'no tasks' : false;

  const items: MenuItem[] = [
    sep('NEW'),
    { name: 'Add', action: { kind: 'route', viewId: 'task-add' }, description: 'Add a new task' },
    sep(),
    sep('BROWSE'),
    { name: 'List', action: { kind: 'route', viewId: 'task-list' }, description: 'List all tasks' },
    sep(),
    sep('EDIT'),
    {
      name: 'Edit',
      action: { kind: 'route', viewId: 'task-edit' },
      description: 'Edit task fields (todo only)',
      disabled: editDisabledReason,
    },
    {
      name: 'Update status',
      action: { kind: 'route', viewId: 'task-edit-status' },
      description: 'Mark in-progress / done / blocked',
      disabled: editDisabledReason,
    },
    sep(),
    sep('MANAGE'),
    { name: 'Remove', action: { kind: 'route', viewId: 'task-remove' }, description: 'Remove a task' },
    sep(),
    { name: 'Back', action: BACK, description: 'Return to Browse' },
  ];

  return { title: `Task${titleSuffix}`, items };
}

// ── project submenu ──────────────────────────────────────────────────────────

function buildProjectSubMenu(ctx: MenuContext): SubMenu {
  const onboardDisabled: string | false = ctx.hasProjects ? false : 'add a project first';

  const items: MenuItem[] = [
    { name: 'Add', action: { kind: 'route', viewId: 'project-add' }, description: 'Register a new project' },
    { name: 'Edit', action: { kind: 'route', viewId: 'project-edit' }, description: 'Edit project details' },
    { name: 'List', action: { kind: 'route', viewId: 'project-list' }, description: 'List all projects' },
    sep(),
    sep('REPOSITORIES'),
    {
      name: 'Add Repository',
      action: { kind: 'route', viewId: 'project-repo-add' },
      description: 'Add a repository to a project',
    },
    {
      name: 'Remove Repository',
      action: { kind: 'route', viewId: 'project-repo-remove' },
      description: 'Remove a repository',
    },
    sep(),
    sep('ONBOARD'),
    {
      name: 'Onboard repo',
      action: { kind: 'launchChain', flow: 'onboard' },
      description: 'AI-assisted setup: scripts + project context file',
      disabled: onboardDisabled,
    },
    sep(),
    { name: 'Remove', action: { kind: 'route', viewId: 'project-remove' }, description: 'Remove a project' },
    { name: 'Back', action: BACK, description: 'Return to Browse' },
  ];

  return { title: 'Project', items };
}

// ── public dispatcher ────────────────────────────────────────────────────────

/**
 * Resolve a submenu by group. Configuration is intentionally absent — the
 * global `s` hotkey reaches the settings panel directly, so a submenu path
 * would be a duplicate.
 */
export function buildSubMenu(group: 'browse' | 'sprint' | 'ticket' | 'task' | 'project', ctx: MenuContext): SubMenu {
  switch (group) {
    case 'browse':
      return buildBrowseMenu(ctx);
    case 'sprint':
      return buildSprintSubMenu(ctx);
    case 'ticket':
      return buildTicketSubMenu(ctx);
    case 'task':
      return buildTaskSubMenu(ctx);
    case 'project':
      return buildProjectSubMenu(ctx);
  }
  const _exhaustive: never = group;
  void _exhaustive;
  // Unreachable — TypeScript proves the switch is exhaustive.
  throw new Error(`buildSubMenu: unknown group ${String(group)}`);
}
