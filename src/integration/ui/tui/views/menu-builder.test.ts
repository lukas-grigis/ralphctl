import { describe, expect, it } from 'vitest';
import { buildBrowseMenu, buildSubMenu, isSeparator, type MenuContext, type MenuItem } from './menu-builder.ts';

/** Helper to extract actionable choices (not separators) from menu items */
function choices(items: MenuItem[]) {
  return items.filter((i): i is { name: string; value: string } => !isSeparator(i) && 'value' in i);
}

/** Minimal menu context with sensible defaults */
function baseCtx(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    hasProjects: true,
    projectCount: 1,
    currentSprintId: null,
    currentSprintName: null,
    currentSprintStatus: null,
    ticketCount: 0,
    taskCount: 0,
    tasksDone: 0,
    tasksInProgress: 0,
    pendingRequirements: 0,
    allRequirementsApproved: false,
    plannedTicketCount: 0,
    nextAction: null,
    aiProvider: null,
    ...overrides,
  };
}

describe('buildSubMenu — config', () => {
  it('is not exposed as a submenu — the global `s` hotkey opens the settings panel directly', () => {
    expect(buildSubMenu('config', baseCtx())).toBeNull();
  });
});

describe('buildBrowseMenu', () => {
  it('exposes every secondary entry point reachable from Home', () => {
    const menu = buildBrowseMenu();
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toEqual([
      'group:sprint',
      'group:ticket',
      'group:task',
      'group:project',
      'action:progress:show',
      'action:doctor:run',
      'back',
    ]);
  });

  it('is reachable via buildSubMenu("browse")', () => {
    const menu = buildSubMenu('browse', baseCtx());
    expect(menu).not.toBeNull();
    expect(menu?.title).toBe('Browse & Setup');
  });
});

describe('buildSubMenu — unknown group', () => {
  it('returns null for unrecognized group', () => {
    expect(buildSubMenu('nonexistent', baseCtx())).toBeNull();
  });
});
