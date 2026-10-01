/**
 * Home menu builder — the recent-sprint rows carry no digit hotkey (`1`–`5` are the global section
 * keys, so a row-local digit would double-fire), and the navigation rows route to sections, System
 * children and the context switcher instead of pushing their roots.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { buildMenuItems } from '@src/application/ui/tui/views/home-internals/menu-items.ts';

const makeSprint = (n: number): Sprint =>
  ({
    id: `sprint-${String(n)}` as unknown as SprintId,
    name: `Sprint ${String(n)}`,
    status: 'draft',
    tickets: [],
  }) as unknown as Sprint;

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
    onPushHome: vi.fn(),
    onGoSection: vi.fn(),
    onOpenSystemChild: vi.fn(),
    onOpenSwitcher: vi.fn(),
    onPushAddTicket: vi.fn(),
    onSwitchSprint: vi.fn(),
    onLaunchCreateSprint: vi.fn(),
  });

describe('buildMenuItems — recent-sprint rows', () => {
  it('has no hotkey on the sprint rows — digits are the global section keys', () => {
    const items = buildWith([makeSprint(1), makeSprint(2), makeSprint(3)]);
    const sprintRows = items.filter((i) => i.id.startsWith('sprint-sprint-'));
    expect(sprintRows).toHaveLength(3);
    for (const row of sprintRows) expect(row.hotkey).toBeUndefined();
    const digits = new Set(['1', '2', '3', '4', '5']);
    expect(items.filter((i) => i.hotkey !== undefined && digits.has(i.hotkey))).toEqual([]);
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
      onPushHome: vi.fn(),
      onGoSection: vi.fn(),
      onOpenSystemChild: vi.fn(),
      onOpenSwitcher: vi.fn(),
      onPushAddTicket: vi.fn(),
      onSwitchSprint,
      onLaunchCreateSprint: vi.fn(),
    });
    const second = items.find((i) => i.id === 'sprint-sprint-2');
    expect(second).toBeDefined();
    second?.onSelect();
    expect(onSwitchSprint).toHaveBeenCalledWith(sprints[1]);
  });
});

describe('buildMenuItems — navigation rows', () => {
  const wire = (): {
    readonly items: ReturnType<typeof buildMenuItems>;
    readonly onGoSection: ReturnType<typeof vi.fn>;
    readonly onOpenSystemChild: ReturnType<typeof vi.fn>;
    readonly onOpenSwitcher: ReturnType<typeof vi.fn>;
    readonly onPushHome: ReturnType<typeof vi.fn>;
  } => {
    const onGoSection = vi.fn();
    const onOpenSystemChild = vi.fn();
    const onOpenSwitcher = vi.fn();
    const onPushHome = vi.fn();
    const items = buildMenuItems({
      hasProject: true,
      projectCount: 1,
      stateLoaded: true,
      loading: false,
      currentSprint: undefined,
      recentSprints: [],
      selectionSprintId: undefined,
      switchSprintDisabled: undefined,
      addTicketDisabled: undefined,
      onPushHome,
      onGoSection,
      onOpenSystemChild,
      onOpenSwitcher,
      onPushAddTicket: vi.fn(),
      onSwitchSprint: vi.fn(),
      onLaunchCreateSprint: vi.fn(),
    });
    return { items, onGoSection, onOpenSystemChild, onOpenSwitcher, onPushHome };
  };

  it('jumps to sections instead of pushing their roots', () => {
    const { items, onGoSection, onPushHome } = wire();
    items.find((i) => i.id === 'sprints')?.onSelect();
    items.find((i) => i.id === 'projects')?.onSelect();
    items.find((i) => i.id === 'sessions')?.onSelect();
    expect(onGoSection.mock.calls.map((c) => c[0])).toEqual(['sprints', 'projects', 'runs']);
    expect(onPushHome).not.toHaveBeenCalled();
  });

  it('opens Settings / Skills / Doctor as System children', () => {
    const { items, onOpenSystemChild } = wire();
    for (const id of ['settings', 'skills', 'doctor']) items.find((i) => i.id === id)?.onSelect();
    expect(onOpenSystemChild.mock.calls.map((c) => c[0])).toEqual(['settings', 'skills', 'doctor']);
  });

  it('opens the switcher for Switch sprint / Switch project', () => {
    const { items, onOpenSwitcher } = wire();
    items.find((i) => i.id === 'pick-sprint')?.onSelect();
    items.find((i) => i.id === 'pick-project')?.onSelect();
    expect(onOpenSwitcher.mock.calls.map((c) => c[0])).toEqual(['sprint', 'project']);
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
      onPushHome: vi.fn(),
      onGoSection: vi.fn(),
      onOpenSystemChild: vi.fn(),
      onOpenSwitcher: vi.fn(),
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
      onPushHome: vi.fn(),
      onGoSection: vi.fn(),
      onOpenSystemChild: vi.fn(),
      onOpenSwitcher: vi.fn(),
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
