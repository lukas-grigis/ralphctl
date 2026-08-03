/**
 * Home-view action-menu builder.
 *
 * Pure function: given the loaded snapshot, the current sprint id, and the wired callbacks,
 * returns the menu definition the orchestrator hands to {@link ActionMenu}. Keeping it pure
 * (no hooks, no closures over Router / Selection / Router) makes the menu shape easy to
 * inspect in tests and isolates the policy decisions (which row to show, what to disable).
 */

import type { MenuItem } from '@src/application/ui/tui/components/action-menu.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ticketAddManifest } from '@src/application/flows/add-ticket/manifest.ts';
import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

/** The "switch sprint" section groups the loading placeholder, the recent-sprint rows, and the
 *  create-new-sprint row — hoisted so the three rows share one literal instead of three copies. */
const SWITCH_SPRINT_SECTION = 'switch sprint';

export interface BuildMenuItemsInput {
  readonly hasProject: boolean;
  /** State.kind === 'ok' — gates the "create your first project" row so it only appears on a loaded empty snapshot. */
  readonly stateLoaded: boolean;
  /**
   * True while the app-state snapshot is still fetching (covers both `loading` and the
   * pre-fetch `idle` tick). `recentSprints` is always empty during this window — without an
   * explicit row the "switch sprint" section looks identical to a genuinely sprint-less
   * project and the 1–5 digit quick-switch hotkeys silently do nothing.
   */
  readonly loading: boolean;
  readonly currentSprint: Sprint | undefined;
  readonly recentSprints: readonly Sprint[];
  readonly selectionSprintId: SprintId | undefined;
  readonly switchSprintDisabled: string | undefined;
  readonly addTicketDisabled: string | undefined;
  readonly onPushHome: (id: ViewId) => void;
  readonly onPushAddTicket: (sprintId: SprintId) => void;
  readonly onSwitchSprint: (sprint: Sprint) => void;
  readonly onLaunchCreateSprint: () => void;
}

/** "Create your first project" — only shown once the snapshot has loaded and confirmed there's
 *  no project yet; before that, showing it would be a false positive on a still-fetching state. */
const buildGetStartedItems = (input: BuildMenuItemsInput): readonly MenuItem[] => {
  if (input.hasProject || !input.stateLoaded) return [];
  return [
    {
      id: 'create-project',
      section: 'get started',
      label: 'Create your first project',
      description: 'Bind a repository to a project — required before any flow can run.',
      hotkey: 'c',
      onSelect: (): void => input.onPushHome('create-project'),
    },
  ];
};

/** The digit quick-switch rows plus their loading placeholder and the create-new-sprint row. */
const buildSwitchSprintItems = (input: BuildMenuItemsInput): readonly MenuItem[] => {
  const items: MenuItem[] = [];

  // Loading placeholder — renders in place of the (always-empty-until-loaded) digit list so a
  // fetch-in-progress reads as "loading", not "no sprints yet". Non-interactive: `disabledReason`
  // keeps it out of the cursorable set, so `1`–`5` stay harmless no-ops during this window instead
  // of landing on a fake row.
  if (input.loading && input.recentSprints.length === 0) {
    items.push({
      id: 'sprint-loading',
      section: SWITCH_SPRINT_SECTION,
      label: '(loading…)',
      disabledReason: 'fetching recent sprints',
      onSelect: () => {
        /* not selectable while loading */
      },
    });
  }

  for (const [idx, s] of input.recentSprints.entries()) {
    const ticketsSuffix = `${String(s.tickets.length)} ticket${s.tickets.length === 1 ? '' : 's'}`;
    const description =
      s.id === input.currentSprint?.id
        ? `(current) ${s.status} ${glyphs.bullet} ${ticketsSuffix}`
        : `${s.status} ${glyphs.bullet} ${ticketsSuffix}`;
    items.push({
      id: `sprint-${String(s.id)}`,
      section: SWITCH_SPRINT_SECTION,
      label: s.name,
      description,
      // Digit quick-switch — recentSprints is capped at 5 (RECENT_SPRINTS_LIMIT), so 1–5
      // always suffice. Deliberately NOT a globalHotkey: ActionMenu owns the binding, so the
      // digits work on Home only and never collide with other views' keys.
      hotkey: String(idx + 1),
      onSelect: (): void => {
        if (s.id === input.selectionSprintId) return;
        // setSprint updates `selection.lastSwitch`, which drives the transient toast line
        // above the menu — no separate flash call needed.
        input.onSwitchSprint(s);
      },
    });
  }

  // Create-new-sprint row sits in the same "switch sprint" section so it groups with the
  // inline shortcut list. Gated on `hasProject` — without one, the create flow has nothing
  // to target. The `+` hint mirrors the global hotkey registered in useInput.
  if (input.hasProject) {
    items.push({
      id: 'create-sprint',
      section: SWITCH_SPRINT_SECTION,
      label: 'Create new sprint',
      description: 'Start a fresh sprint and select it as the current one.',
      hotkey: '+',
      globalHotkey: true,
      onSelect: (): void => input.onLaunchCreateSprint(),
    });
  }

  return items;
};

/** The primary "work" section rows — the flow launcher plus every sprint/project/ticket picker. */
const buildWorkItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  {
    id: 'flows',
    section: 'work',
    label: 'Start a flow',
    description: 'Pick from refine, plan, implement, readiness, and more.',
    hotkey: 'n',
    globalHotkey: true,
    onSelect: (): void => input.onPushHome('flows'),
  },
  {
    id: 'sprints',
    section: 'work',
    label: 'Sprints',
    description: 'Construct and run sprints — the main unit of work.',
    hotkey: 'r',
    onSelect: (): void => input.onPushHome('sprints'),
  },
  {
    id: 'pick-sprint',
    section: 'work',
    label: 'Switch sprint',
    description: 'Pick a different sprint — remembered for next launch.',
    hotkey: 'S',
    globalHotkey: true,
    ...(input.switchSprintDisabled !== undefined ? { disabledReason: input.switchSprintDisabled } : {}),
    onSelect: (): void => input.onPushHome('pick-sprint'),
  },
  {
    id: ticketAddManifest.id,
    section: 'work',
    label: ticketAddManifest.title,
    description: ticketAddManifest.description,
    hotkey: 'a',
    ...(input.addTicketDisabled !== undefined ? { disabledReason: input.addTicketDisabled } : {}),
    onSelect: (): void => {
      if (input.selectionSprintId === undefined) return;
      input.onPushAddTicket(input.selectionSprintId);
    },
  },
  {
    id: 'pick-project',
    section: 'work',
    label: 'Switch project',
    description: 'Pick a different project — remembered for next launch.',
    hotkey: 'P',
    globalHotkey: true,
    onSelect: (): void => input.onPushHome('pick-project'),
  },
  {
    id: 'projects',
    section: 'work',
    label: 'Projects',
    description: 'Browse projects and manage their repositories.',
    hotkey: 'p',
    onSelect: (): void => input.onPushHome('projects'),
  },
];

/** The "observe" section — currently the single active-sessions row, split out so a future
 *  addition doesn't grow it back into the "work" section by convenience. */
const buildObserveItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  {
    id: 'sessions',
    section: 'observe',
    label: 'Active sessions',
    description: 'Live and recent runs of any flow.',
    hotkey: 'x',
    globalHotkey: true,
    onSelect: (): void => input.onPushHome('sessions'),
  },
];

/** The "system" section — settings, the skills catalog, and the doctor diagnostics. */
const buildSystemItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  {
    id: 'settings',
    section: 'system',
    label: 'Settings',
    description: 'AI provider, models, harness budgets.',
    hotkey: 's',
    globalHotkey: true,
    onSelect: (): void => input.onPushHome('settings'),
  },
  {
    id: 'skills',
    section: 'system',
    label: 'Skills catalog',
    description: 'Browse, enable, disable, and update opt-in skills.',
    hotkey: 'K',
    onSelect: (): void => input.onPushHome('skills'),
  },
  {
    id: 'doctor',
    section: 'system',
    label: 'Doctor',
    description: 'Sanity checks for paths, config, and runtime.',
    hotkey: '!',
    globalHotkey: true,
    onSelect: (): void => input.onPushHome('doctor'),
  },
];

/** The stable navigation rows — work / observe / system — present regardless of loading state. */
const buildNavItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  ...buildWorkItems(input),
  ...buildObserveItems(input),
  ...buildSystemItems(input),
];

export const buildMenuItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  ...buildGetStartedItems(input),
  ...buildSwitchSprintItems(input),
  ...buildNavItems(input),
];
