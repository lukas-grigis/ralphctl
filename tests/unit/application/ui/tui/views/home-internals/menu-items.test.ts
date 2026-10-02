/**
 * Home menu builder — digit quick-switch hotkeys on the recent-sprint rows.
 *
 * Each "switch sprint" row carries `hotkey: '1'..'N'` (recentSprints is capped at 5 upstream,
 * so digits always suffice) and must NOT be flagged `globalHotkey` — ActionMenu owns the
 * binding so the digits work on Home only.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { buildMenuItems, type BuildMenuItemsInput } from '@src/application/ui/tui/views/home-internals/menu-items.ts';

const makeSprint = (n: number): Sprint =>
  ({
    id: `sprint-${String(n)}` as unknown as SprintId,
    name: `Sprint ${String(n)}`,
    status: 'draft',
    tickets: [],
  }) as unknown as Sprint;

const NO_ATTENTION = {
  waitingRuns: [],
  interruptedTasks: [],
  interruptedFacts: new Map(),
  now: 0,
  onResumeImplement: vi.fn(),
  onOpenRun: vi.fn(),
} as const;

const buildWith = (recentSprints: readonly Sprint[]): ReturnType<typeof buildMenuItems> =>
  buildMenuItems({
    hasProject: true,
    projectCount: 1,
    stateLoaded: true,
    loading: false,
    currentSprint: undefined,
    recentSprints,
    selectionSprintId: undefined,
    switchSprintDisabled: undefined,
    addTicketDisabled: undefined,
    ...NO_ATTENTION,
    onPushHome: vi.fn(),
    onPushAddTicket: vi.fn(),
    onSwitchSprint: vi.fn(),
    onLaunchCreateSprint: vi.fn(),
  });

describe('buildMenuItems — recent-sprint digit hotkeys', () => {
  it('assigns 1..N to the sprint rows in order', () => {
    const items = buildWith([makeSprint(1), makeSprint(2), makeSprint(3)]);
    const sprintRows = items.filter((i) => i.id.startsWith('sprint-sprint-'));
    expect(sprintRows.map((i) => i.hotkey)).toEqual(['1', '2', '3']);
  });

  it('keeps the digit binding local to the menu (no globalHotkey)', () => {
    const items = buildWith([makeSprint(1), makeSprint(2)]);
    for (const row of items.filter((i) => i.id.startsWith('sprint-sprint-'))) {
      expect(row.globalHotkey).not.toBe(true);
    }
  });

  it('selecting a row via its callback switches to that sprint', () => {
    const onSwitchSprint = vi.fn();
    const sprints = [makeSprint(1), makeSprint(2)];
    const items = buildMenuItems({
      hasProject: true,
      projectCount: 1,
      stateLoaded: true,
      loading: false,
      currentSprint: undefined,
      recentSprints: sprints,
      selectionSprintId: undefined,
      switchSprintDisabled: undefined,
      addTicketDisabled: undefined,
      ...NO_ATTENTION,
      onPushHome: vi.fn(),
      onPushAddTicket: vi.fn(),
      onSwitchSprint,
      onLaunchCreateSprint: vi.fn(),
    });
    const second = items.find((i) => i.hotkey === '2');
    expect(second).toBeDefined();
    second?.onSelect();
    expect(onSwitchSprint).toHaveBeenCalledWith(sprints[1]);
  });
});

describe('buildMenuItems — loading placeholder', () => {
  const buildLoading = (loading: boolean, recentSprints: readonly Sprint[] = []): ReturnType<typeof buildMenuItems> =>
    buildMenuItems({
      hasProject: false,
      projectCount: 0,
      stateLoaded: false,
      loading,
      currentSprint: undefined,
      recentSprints,
      selectionSprintId: undefined,
      switchSprintDisabled: 'no project loaded',
      addTicketDisabled: 'pick a sprint first',
      ...NO_ATTENTION,
      onPushHome: vi.fn(),
      onPushAddTicket: vi.fn(),
      onSwitchSprint: vi.fn(),
      onLaunchCreateSprint: vi.fn(),
    });

  it('shows a non-selectable "(loading…)" row while the snapshot fetch is in flight', () => {
    const items = buildLoading(true);
    const row = items.find((i) => i.id === 'sprint-loading');
    expect(row).toBeDefined();
    expect(row?.label).toContain('loading');
    // disabledReason keeps it out of the ActionMenu's cursorable/hotkey-matchable set.
    expect(row?.disabledReason).toBeDefined();
    expect(row?.hotkey).toBeUndefined();
  });

  it('omits the loading row once the snapshot has settled', () => {
    const items = buildLoading(false);
    expect(items.find((i) => i.id === 'sprint-loading')).toBeUndefined();
  });

  it('omits the loading row when recent sprints are already known (a settled reload mid-flight)', () => {
    const items = buildLoading(true, [makeSprint(1)]);
    expect(items.find((i) => i.id === 'sprint-loading')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// "Create your first project" — gated on storage being empty, not on a project being SELECTED
//
// `hasProject` means "a project is currently picked". Gating the get-started row on it offered
// to create a *first* project to anyone who had several and had simply not picked one yet —
// contradicting the state card beside it, which correctly read "N projects in storage".
// ────────────────────────────────────────────────────────────────────────────────────────────

describe('buildMenuItems — get-started row', () => {
  const build = (projectCount: number, hasProject: boolean): ReturnType<typeof buildMenuItems> =>
    buildMenuItems({
      hasProject,
      projectCount,
      stateLoaded: true,
      loading: false,
      currentSprint: undefined,
      recentSprints: [],
      selectionSprintId: undefined,
      switchSprintDisabled: undefined,
      addTicketDisabled: undefined,
      ...NO_ATTENTION,
      onPushHome: vi.fn(),
      onPushAddTicket: vi.fn(),
      onSwitchSprint: vi.fn(),
      onLaunchCreateSprint: vi.fn(),
    });

  const hasCreateRow = (items: ReturnType<typeof buildMenuItems>): boolean =>
    items.some((i) => i.id === 'create-project');

  it('offers it when storage holds no project at all', () => {
    expect(hasCreateRow(build(0, false))).toBe(true);
  });

  it('withholds it when projects exist but none is selected', () => {
    expect(hasCreateRow(build(3, false))).toBe(false);
  });

  it('withholds it when a project is selected', () => {
    expect(hasCreateRow(build(3, true))).toBe(false);
  });
});

describe('buildMenuItems — needs attention', () => {
  const base = (over: Partial<BuildMenuItemsInput>): ReturnType<typeof buildMenuItems> =>
    buildMenuItems({
      hasProject: true,
      projectCount: 1,
      stateLoaded: true,
      loading: false,
      currentSprint: undefined,
      recentSprints: [],
      selectionSprintId: undefined,
      switchSprintDisabled: undefined,
      addTicketDisabled: undefined,
      ...NO_ATTENTION,
      onPushHome: vi.fn(),
      onPushAddTicket: vi.fn(),
      onSwitchSprint: vi.fn(),
      onLaunchCreateSprint: vi.fn(),
      ...over,
    });

  const task = (n: number, startedAt = 0) => ({
    taskId: `t${String(n)}`,
    name: `Task ${String(n)}`,
    attemptN: 2,
    startedAt,
  });

  it('adds no group while nothing is interrupted or waiting', () => {
    expect(base({}).some((i) => i.section === 'needs attention')).toBe(false);
  });

  it('leads the menu with the interrupted task, its age and attempt, and resumes Implement', () => {
    const onResumeImplement = vi.fn();
    const items = base({
      interruptedTasks: [task(1, 0)],
      interruptedFacts: new Map([['t1', { uncommitted: 3, resumable: true }]]),
      now: 12 * 60_000,
      onResumeImplement,
    });
    const row = items[0];
    expect(row?.section).toBe('needs attention');
    expect(row?.label).toBe('"Task 1" was interrupted · attempt 2 · 12m ago');
    expect(row?.description).toContain('3 uncommitted changes');
    expect(row?.description).toContain('↵ resumes Implement');
    row?.onSelect();
    expect(onResumeImplement).toHaveBeenCalledOnce();
  });

  it('caps the rows and folds the rest into one that still resumes everything', () => {
    const items = base({ interruptedTasks: [1, 2, 3, 4, 5].map((n) => task(n)) });
    const rows = items.filter((i) => i.section === 'needs attention');
    expect(rows).toHaveLength(4);
    expect(rows.at(-1)?.label).toBe('2 more interrupted — resume picks them all up');
  });

  it('lists a run waiting on an answer and opens it', () => {
    const onOpenRun = vi.fn();
    const items = base({
      waitingRuns: [{ sessionId: 's1', title: 'Plan sprint', since: 0 }],
      now: 3 * 60_000,
      onOpenRun,
    });
    const row = items[0];
    expect(row?.label).toContain('[WAITING] Plan sprint');
    expect(row?.label).toContain('3m');
    row?.onSelect();
    expect(onOpenRun).toHaveBeenCalledWith('s1');
  });

  it('offers Housekeeping in the system group', () => {
    const row = base({}).find((i) => i.id === 'housekeeping');
    expect(row).toMatchObject({ section: 'system', hotkey: 'H' });
  });
});
