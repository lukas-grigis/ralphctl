import { describe, expect, it } from 'vitest';
import { buildMainMenu, buildSubMenu, isSeparator, type MenuContext, type MenuItem } from './menu-builder.ts';

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
  const ctx = baseCtx();

  it('returns a config submenu with correct title', () => {
    const menu = buildSubMenu('config', ctx);
    expect(menu).not.toBeNull();
    if (menu !== null) {
      expect(menu.title).toBe('Configuration');
    }
  });

  it('includes Show Settings choice', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toContain('show');
  });

  it('includes Set AI Provider choice', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toContain('set provider');
  });

  it('includes Set Editor choice', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toContain('set editor');
  });

  it('includes Set Evaluation Iterations choice', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toContain('set evaluationIterations');
  });

  it('includes Back choice', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toContain('back');
  });

  it('has all config choices in expected order', () => {
    const menu = buildSubMenu('config', ctx);
    if (menu === null) throw new Error('menu should not be null');
    const vals = choices(menu.items).map((c) => c.value);
    expect(vals).toEqual(['show', 'set provider', 'set editor', 'set evaluationIterations', 'back']);
  });
});

describe('buildMainMenu — setup section', () => {
  it('includes Configuration entry that routes to config submenu', () => {
    const ctx = baseCtx();
    const { items } = buildMainMenu(ctx);
    const vals = choices(items).map((c) => c.value);
    expect(vals).toContain('config');
  });
});

describe('buildSubMenu — unknown group', () => {
  it('returns null for unrecognized group', () => {
    expect(buildSubMenu('nonexistent', baseCtx())).toBeNull();
  });
});
