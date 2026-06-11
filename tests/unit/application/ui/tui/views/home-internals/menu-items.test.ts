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
    stateLoaded: true,
    currentSprint: undefined,
    recentSprints,
    selectionSprintId: undefined,
    switchSprintDisabled: undefined,
    addTicketDisabled: undefined,
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
      stateLoaded: true,
      currentSprint: undefined,
      recentSprints: sprints,
      selectionSprintId: undefined,
      switchSprintDisabled: undefined,
      addTicketDisabled: undefined,
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
