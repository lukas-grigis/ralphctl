import { describe, expect, it } from 'vitest';
import {
  HIDDEN_BY_DEFAULT_FLOW_IDS,
  PROJECT_SCOPED_FLOW_IDS,
  sectionFor,
  SPRINT_SCOPED_FLOW_IDS,
  visibleFlowsFor,
} from '@src/application/ui/tui/views/flows-visibility.ts';

describe('visibleFlowsFor', () => {
  it('returns nothing when no project is loaded and no sprint is selected', () => {
    const visible = visibleFlowsFor({ hasProject: false, showAll: false });
    expect(visible.size).toBe(0);
  });

  it('returns only project-scoped flows when a project is loaded but no sprint is selected', () => {
    const visible = visibleFlowsFor({ hasProject: true, showAll: false });
    for (const id of PROJECT_SCOPED_FLOW_IDS) expect(visible.has(id)).toBe(true);
    for (const id of SPRINT_SCOPED_FLOW_IDS) expect(visible.has(id)).toBe(false);
  });

  it('draft sprint: refine + add-tickets + plan + ticket-remove are visible; ticket-add is not', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'draft', showAll: false });
    expect(visible.has('refine')).toBe(true);
    expect(visible.has('add-tickets')).toBe(true);
    expect(visible.has('plan')).toBe(true);
    expect(visible.has('ticket-remove')).toBe(true);
    expect(visible.has('ticket-add')).toBe(false);
    expect(visible.has('implement')).toBe(false);
    expect(visible.has('review')).toBe(false);
    expect(visible.has('close-sprint')).toBe(false);
  });

  it('planned sprint: implement + ticket-remove are visible; ticket-add/refine/plan are not', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'planned', showAll: false });
    expect(visible.has('implement')).toBe(true);
    expect(visible.has('ticket-remove')).toBe(true);
    expect(visible.has('ticket-add')).toBe(false);
    expect(visible.has('refine')).toBe(false);
    expect(visible.has('plan')).toBe(false);
  });

  it('active sprint: implement only (no add or remove via Flows menu during active execution)', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'active', showAll: false });
    expect(visible.has('implement')).toBe(true);
    expect(visible.has('ticket-add')).toBe(false);
    expect(visible.has('ticket-remove')).toBe(false);
  });

  it('review sprint: only review + close-sprint are visible (no refine/plan/implement)', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'review', showAll: false });
    expect(visible.has('review')).toBe(true);
    expect(visible.has('close-sprint')).toBe(true);
    for (const id of ['refine', 'plan', 'implement', 'add-tickets', 'create-pr']) {
      expect(visible.has(id)).toBe(false);
    }
  });

  it('done sprint: only create-pr is visible from sprint-scoped flows', () => {
    const visible = visibleFlowsFor({ hasProject: true, sprintStatus: 'done', showAll: false });
    expect(visible.has('create-pr')).toBe(true);
    expect(visible.has('close-sprint')).toBe(false);
    expect(visible.has('implement')).toBe(false);
  });

  it('project-scoped flows stay visible at every sprint status', () => {
    for (const status of ['draft', 'planned', 'active', 'review', 'done'] as const) {
      const visible = visibleFlowsFor({ hasProject: true, sprintStatus: status, showAll: false });
      for (const id of PROJECT_SCOPED_FLOW_IDS) {
        expect(visible.has(id)).toBe(true);
      }
    }
  });

  it('showAll=true returns every known flow regardless of state, including hidden ones', () => {
    const visible = visibleFlowsFor({ hasProject: false, showAll: true });
    for (const id of PROJECT_SCOPED_FLOW_IDS) expect(visible.has(id)).toBe(true);
    for (const id of SPRINT_SCOPED_FLOW_IDS) expect(visible.has(id)).toBe(true);
    for (const id of HIDDEN_BY_DEFAULT_FLOW_IDS) expect(visible.has(id)).toBe(true);
  });

  it('hidden-by-default flows do not appear in any default-mode result', () => {
    const cases: ReadonlyArray<Parameters<typeof visibleFlowsFor>[0]> = [
      { hasProject: false, showAll: false },
      { hasProject: true, showAll: false },
      { hasProject: true, sprintStatus: 'draft', showAll: false },
      { hasProject: true, sprintStatus: 'planned', showAll: false },
      { hasProject: true, sprintStatus: 'active', showAll: false },
      { hasProject: true, sprintStatus: 'review', showAll: false },
      { hasProject: true, sprintStatus: 'done', showAll: false },
    ];
    for (const input of cases) {
      const visible = visibleFlowsFor(input);
      for (const id of HIDDEN_BY_DEFAULT_FLOW_IDS) {
        expect(visible.has(id)).toBe(false);
      }
    }
  });

  it('removed flows (settings, doctor, ticket-add) do not appear in any mode (default OR showAll)', () => {
    const showAll = visibleFlowsFor({ hasProject: true, sprintStatus: 'draft', showAll: true });
    const defaultMode = visibleFlowsFor({ hasProject: true, sprintStatus: 'draft', showAll: false });
    expect(showAll.has('settings')).toBe(false);
    expect(showAll.has('doctor')).toBe(false);
    // ticket-add was removed from the registry; its use-case survives for CLI + the `a` shortcut
    // wizard but it no longer appears as a Flows menu entry in any visibility mode.
    expect(showAll.has('ticket-add')).toBe(false);
    expect(defaultMode.has('settings')).toBe(false);
    expect(defaultMode.has('doctor')).toBe(false);
    expect(defaultMode.has('ticket-add')).toBe(false);
  });
});

describe('sectionFor', () => {
  it.each(PROJECT_SCOPED_FLOW_IDS.map((id) => [id]))('classifies project-scoped flow %s as "project"', (id) => {
    expect(sectionFor(id)).toBe('project');
  });

  it.each(SPRINT_SCOPED_FLOW_IDS.map((id) => [id]))('classifies sprint-scoped flow %s as "sprint"', (id) => {
    expect(sectionFor(id)).toBe('sprint');
  });

  it('falls back to "more" for unknown flow ids', () => {
    expect(sectionFor('totally-made-up-flow')).toBe('more');
  });
});
