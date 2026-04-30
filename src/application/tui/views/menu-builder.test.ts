/**
 * Snapshot-style tests for menu builders.
 * Asserts the items + their typed `MenuAction` for key MenuContext states.
 */
import { describe, it, expect } from 'vitest';
import { buildBrowseMenu, buildSubMenu, isSeparator, type Choice, type MenuContext } from './menu-builder.ts';
import type { MenuAction } from './menu-action.ts';
import { SprintId } from '../../../domain/values/sprint-id.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function parseSprintId(s: string): SprintId {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

// A valid sprint-id slug format: YYYYMMDD-HHmmss-slug
const SPRINT_ID = parseSprintId('20240101-120000-test');

function makeCtx(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    hasProjects: true,
    projectCount: 2,
    currentSprintId: SPRINT_ID,
    currentSprintName: 'My Sprint',
    currentSprintStatus: 'draft',
    ticketCount: 3,
    taskCount: 5,
    tasksDone: 2,
    tasksInProgress: 1,
    pendingRequirements: 1,
    allRequirementsApproved: false,
    plannedTicketCount: 2,
    aiProvider: 'claude',
    currentSprintHasBranch: false,
    currentSprintHasPullRequest: false,
    ...overrides,
  };
}

function getChoices(menu: ReturnType<typeof buildBrowseMenu>): Choice[] {
  return menu.items.filter((item): item is Choice => !isSeparator(item));
}

function findByName(menu: ReturnType<typeof buildBrowseMenu>, name: string): Choice | undefined {
  return getChoices(menu).find((c) => c.name === name);
}

function actionEquals(a: MenuAction, b: MenuAction): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'route':
      return b.kind === 'route' && a.viewId === b.viewId;
    case 'launchChain':
      return b.kind === 'launchChain' && a.flow === b.flow;
    case 'subMenu':
      return b.kind === 'subMenu' && a.group === b.group;
    case 'back':
      return b.kind === 'back';
  }
}

function hasAction(menu: ReturnType<typeof buildBrowseMenu>, action: MenuAction): boolean {
  return getChoices(menu).some((c) => actionEquals(c.action, action));
}

// ── buildBrowseMenu ───────────────────────────────────────────────────────────

describe('buildBrowseMenu', () => {
  it('includes Tickets and Tasks entries', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(findByName(menu, 'Tickets')).toBeDefined();
    expect(findByName(menu, 'Tasks')).toBeDefined();
  });

  it('disables Tickets + Tasks when no current sprint', () => {
    const menu = buildBrowseMenu(makeCtx({ currentSprintId: null }));
    expect(findByName(menu, 'Tickets')?.disabled).toBeTruthy();
    expect(findByName(menu, 'Tasks')?.disabled).toBeTruthy();
  });

  it('includes Sprints and Projects (always enabled)', () => {
    const menu = buildBrowseMenu(makeCtx({ currentSprintId: null }));
    const sprints = findByName(menu, 'Sprints');
    const projects = findByName(menu, 'Projects');
    expect(sprints).toBeDefined();
    expect(Boolean(sprints?.disabled)).toBe(false);
    expect(projects).toBeDefined();
    expect(Boolean(projects?.disabled)).toBe(false);
  });

  it('includes a Back entry', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(hasAction(menu, { kind: 'back' })).toBe(true);
  });

  it('shows sprint name in separator when current sprint exists', () => {
    const menu = buildBrowseMenu(makeCtx({ currentSprintName: 'Alpha Sprint' }));
    const seps = menu.items.filter(isSeparator);
    expect(seps.some((s) => s.separator.includes('Alpha Sprint'))).toBe(true);
  });

  it('Tickets drills into the ticket submenu', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(findByName(menu, 'Tickets')?.action).toEqual({ kind: 'subMenu', group: 'ticket' });
  });

  it('Sprints drills into the sprint submenu', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(findByName(menu, 'Sprints')?.action).toEqual({ kind: 'subMenu', group: 'sprint' });
  });

  it('Projects drills into the project submenu (where Onboard lives)', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(findByName(menu, 'Projects')?.action).toEqual({ kind: 'subMenu', group: 'project' });
  });

  it('Tasks drills into the task submenu', () => {
    const menu = buildBrowseMenu(makeCtx());
    expect(findByName(menu, 'Tasks')?.action).toEqual({ kind: 'subMenu', group: 'task' });
  });

  it('includes a top-level "Onboard a repo" entry that launches the onboard chain', () => {
    const menu = buildBrowseMenu(makeCtx({ hasProjects: true }));
    const onboard = findByName(menu, 'Onboard a repo');
    expect(onboard).toBeDefined();
    expect(onboard?.action).toEqual({ kind: 'launchChain', flow: 'onboard' });
    expect(Boolean(onboard?.disabled)).toBe(false);
  });

  it('top-level "Onboard a repo" is disabled when no projects exist', () => {
    const menu = buildBrowseMenu(makeCtx({ hasProjects: false }));
    const onboard = findByName(menu, 'Onboard a repo');
    expect(onboard?.disabled).toBe('add a project first');
  });
});

// ── buildSubMenu dispatches ────────────────────────────────────────────────────

describe('buildSubMenu', () => {
  it('returns browse menu for group=browse', () => {
    const menu = buildSubMenu('browse', makeCtx());
    expect(menu.title).toBe('Browse');
  });

  it('returns sprint submenu for group=sprint — includes Create and List', () => {
    const menu = buildSubMenu('sprint', makeCtx());
    expect(hasAction(menu, { kind: 'route', viewId: 'sprint-create' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'sprint-list' })).toBe(true);
  });

  it('sprint submenu — exposes Progress entry routing to the progress view', () => {
    const menu = buildSubMenu('sprint', makeCtx());
    expect(hasAction(menu, { kind: 'route', viewId: 'progress' })).toBe(true);
  });

  it('sprint submenu — Progress disabled when no current sprint', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintId: null }));
    expect(findByName(menu, 'Progress')?.disabled).toBeTruthy();
  });

  it('sprint submenu — exposes Requirements + Context exports under EXPORT', () => {
    const menu = buildSubMenu('sprint', makeCtx());
    expect(hasAction(menu, { kind: 'route', viewId: 'sprint-export-requirements' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'sprint-export-context' })).toBe(true);
  });

  it('sprint submenu — EXPORT entries disabled when no current sprint', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintId: null }));
    expect(findByName(menu, 'Requirements')?.disabled).toBeTruthy();
    expect(findByName(menu, 'Context')?.disabled).toBeTruthy();
  });

  it('sprint submenu — has an EXPORT separator section between BROWSE and EDIT', () => {
    const menu = buildSubMenu('sprint', makeCtx());
    const labels = menu.items
      .filter(isSeparator)
      .map((s) => s.separator)
      .filter((s) => s.length > 0);
    const browseIdx = labels.indexOf('BROWSE');
    const exportIdx = labels.indexOf('EXPORT');
    const editIdx = labels.indexOf('EDIT');
    expect(browseIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeGreaterThan(browseIdx);
    expect(editIdx).toBeGreaterThan(exportIdx);
  });

  it('sprint submenu title includes sprint name for current sprint', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintName: 'Delta' }));
    expect(menu.title).toContain('Delta');
  });

  it('sprint submenu — Create PR / MR launches the create-pr chain', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintHasBranch: true, currentSprintHasPullRequest: false }));
    const choice = getChoices(menu).find((c) => c.name === 'Create PR / MR');
    expect(choice).toBeDefined();
    expect(choice?.action).toEqual({ kind: 'launchChain', flow: 'create-pr' });
    expect(Boolean(choice?.disabled)).toBe(false);
  });

  it('sprint submenu — Create PR disabled when sprint has no branch', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintHasBranch: false, currentSprintHasPullRequest: false }));
    const choice = getChoices(menu).find((c) => c.name === 'Create PR / MR');
    expect(choice?.disabled).toBe('sprint has no branch');
  });

  it('sprint submenu — Create PR disabled once a PR has already been recorded', () => {
    const menu = buildSubMenu('sprint', makeCtx({ currentSprintHasBranch: true, currentSprintHasPullRequest: true }));
    const choice = getChoices(menu).find((c) => c.name === 'Create PR / MR');
    expect(choice?.disabled).toBe('pr already created');
  });

  it('ticket submenu — Add disabled when no projects', () => {
    const menu = buildSubMenu('ticket', makeCtx({ hasProjects: false }));
    expect(findByName(menu, 'Add')?.disabled).toBeTruthy();
  });

  it('ticket submenu — Refine disabled when not a draft sprint', () => {
    const menu = buildSubMenu('ticket', makeCtx({ currentSprintStatus: 'active' }));
    expect(findByName(menu, 'Refine')?.disabled).toBeTruthy();
  });

  it('ticket submenu — Refine disabled when no approved tickets', () => {
    const menu = buildSubMenu('ticket', makeCtx({ ticketCount: 1, pendingRequirements: 1 }));
    expect(findByName(menu, 'Refine')?.disabled).toBeTruthy();
  });

  it('ticket submenu — Refine enabled when draft + approved tickets', () => {
    const menu = buildSubMenu(
      'ticket',
      makeCtx({ currentSprintStatus: 'draft', ticketCount: 2, pendingRequirements: 0 })
    );
    expect(Boolean(findByName(menu, 'Refine')?.disabled)).toBe(false);
  });

  it('ticket submenu — Refine action launches the refine chain', () => {
    const menu = buildSubMenu(
      'ticket',
      makeCtx({ currentSprintStatus: 'draft', ticketCount: 2, pendingRequirements: 0 })
    );
    expect(findByName(menu, 'Refine')?.action).toEqual({ kind: 'launchChain', flow: 'refine' });
  });

  it('task submenu — includes List, Add, Status, Remove', () => {
    const menu = buildSubMenu('task', makeCtx());
    expect(hasAction(menu, { kind: 'route', viewId: 'task-list' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'task-add' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'task-edit-status' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'task-remove' })).toBe(true);
  });

  it('project submenu — includes Add, Edit, List, Add Repository, Remove', () => {
    const menu = buildSubMenu('project', makeCtx());
    expect(hasAction(menu, { kind: 'route', viewId: 'project-add' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'project-edit' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'project-list' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'project-repo-add' })).toBe(true);
    expect(hasAction(menu, { kind: 'route', viewId: 'project-remove' })).toBe(true);
  });

  it('project submenu — includes Onboard repo entry that launches the onboard chain', () => {
    const menu = buildSubMenu('project', makeCtx({ hasProjects: true }));
    const onboard = getChoices(menu).find((c) => c.name === 'Onboard repo');
    expect(onboard).toBeDefined();
    expect(onboard?.action).toEqual({ kind: 'launchChain', flow: 'onboard' });
    expect(Boolean(onboard?.disabled)).toBe(false);
  });

  it('project submenu — Onboard repo disabled when no projects', () => {
    const menu = buildSubMenu('project', makeCtx({ hasProjects: false }));
    const onboard = getChoices(menu).find((c) => c.name === 'Onboard repo');
    expect(onboard?.disabled).toBe('add a project first');
  });

  it('all submenus include a Back entry', () => {
    const groups = ['browse', 'sprint', 'ticket', 'task', 'project'] as const;
    for (const group of groups) {
      const menu = buildSubMenu(group, makeCtx());
      expect(hasAction(menu, { kind: 'back' }), `${group} submenu missing back`).toBe(true);
    }
  });
});
