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
import { plural } from '@src/application/ui/shared/plural.ts';
import { fmtSpan } from '@src/application/ui/tui/theme/duration.ts';
import type { InterruptedFacts, InterruptedTask } from '@src/application/ui/shared/interrupted-tasks.ts';
import { ticketAddManifest } from '@src/application/flows/add-ticket/manifest.ts';
import type { ViewId } from '@src/application/ui/tui/views/view-registry.tsx';

/** The "switch sprint" section groups the loading placeholder, the recent-sprint rows, and the
 *  create-new-sprint row — hoisted so the three rows share one literal instead of three copies. */
const SWITCH_SPRINT_SECTION = 'switch sprint';

/** Rows that need the operator before anything else — currently interrupted tasks. */
const NEEDS_ATTENTION_SECTION = 'needs attention';

/** More interrupted tasks than this collapse into one "N more" row; resuming Implement picks them all up. */
const INTERRUPTED_ROW_CAP = 3;

/** A run parked on a prompt: nothing moves until the operator answers. */
export interface WaitingRun {
  readonly sessionId: string;
  readonly title: string;
  /** Epoch ms the prompt was queued. */
  readonly since: number;
}

export interface BuildMenuItemsInput {
  readonly hasProject: boolean;
  /**
   * Total projects in storage — NOT whether one is selected. The "create your first project" row
   * gates on this: `hasProject` only says a project is currently picked, so gating the row on it
   * offered to create a first project to someone who already had several and had merely not
   * picked one. The state card next to the menu has always drawn this distinction
   * (`state-card.tsx` renders "N projects in storage. press p to select one"); the menu now
   * agrees with it.
   */
  readonly projectCount: number;
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
  readonly waitingRuns: readonly WaitingRun[];
  /** In-progress tasks whose attempt died with the harness; empty while another process owns the sprint. */
  readonly interruptedTasks: readonly InterruptedTask[];
  /** Disk facts per interrupted task id; they arrive after the rows, which render without them. */
  readonly interruptedFacts: ReadonlyMap<string, InterruptedFacts>;
  /** Epoch ms for the `12m ago` fact. */
  readonly now: number;
  readonly onResumeImplement: () => void;
  readonly onOpenRun: (sessionId: string) => void;
  readonly onPushHome: (id: ViewId) => void;
  readonly onPushAddTicket: (sprintId: SprintId) => void;
  readonly onSwitchSprint: (sprint: Sprint) => void;
  readonly onLaunchCreateSprint: () => void;
}

/** What the operator needs to know before resuming; unknown facts are left out rather than guessed. */
const interruptedDetail = (facts: InterruptedFacts | undefined): string => {
  const parts = [
    facts?.uncommitted !== undefined && facts.uncommitted > 0 ? plural(facts.uncommitted, 'uncommitted change') : '',
    facts?.resumable === true ? 'session resumable' : '',
    facts?.resumable === false ? 'no session to resume, restarts from the brief' : '',
  ].filter((p) => p !== '');
  return [...parts, `↵ resumes Implement`].join(` ${glyphs.bullet} `);
};

const buildWaitingItems = (input: BuildMenuItemsInput): readonly MenuItem[] =>
  input.waitingRuns.map((run): MenuItem => ({
    id: `waiting-${run.sessionId}`,
    section: NEEDS_ATTENTION_SECTION,
    label: `${glyphs.warningGlyph} [WAITING] ${run.title} ${glyphs.bullet} ${fmtSpan(input.now - run.since)}`,
    description: `The run is parked on your answer ${glyphs.bullet} ↵ opens it`,
    onSelect: (): void => input.onOpenRun(run.sessionId),
  }));

/** The NEEDS ATTENTION group: runs waiting on an answer, then one row per interrupted task (capped) resuming Implement. */
const buildAttentionItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  ...buildWaitingItems(input),
  ...buildInterruptedItems(input),
];

const buildInterruptedItems = (input: BuildMenuItemsInput): readonly MenuItem[] => {
  const shown = input.interruptedTasks.slice(0, INTERRUPTED_ROW_CAP);
  const items = shown.map((task, idx): MenuItem => ({
    id: `interrupted-${task.taskId}`,
    section: NEEDS_ATTENTION_SECTION,
    label: `"${task.name}" was interrupted ${glyphs.bullet} attempt ${String(task.attemptN)} ${glyphs.bullet} ${fmtSpan(
      input.now - (input.interruptedFacts.get(task.taskId)?.since ?? task.startedAt)
    )} ago`,
    description: interruptedDetail(input.interruptedFacts.get(task.taskId)),
    ...(idx === 0 ? { hotkey: 'i' } : {}),
    onSelect: input.onResumeImplement,
  }));
  const overflow = input.interruptedTasks.length - shown.length;
  if (overflow > 0) {
    items.push({
      id: 'interrupted-overflow',
      section: NEEDS_ATTENTION_SECTION,
      label: `${String(overflow)} more interrupted ${glyphs.emDash} resume picks them all up`,
      onSelect: input.onResumeImplement,
    });
  }
  return items;
};

/** "Create your first project" — only shown once the snapshot has loaded and confirmed storage
 *  holds no project at all; before that, showing it would be a false positive on a still-fetching
 *  state, and gating on the SELECTED project would show it to anyone browsing without a pick. */
const buildGetStartedItems = (input: BuildMenuItemsInput): readonly MenuItem[] => {
  if (input.projectCount > 0 || !input.stateLoaded) return [];
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

/** The "system" section — settings, the skills catalog, the doctor diagnostics, and housekeeping. */
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
  {
    id: 'housekeeping',
    section: 'system',
    label: 'Housekeeping',
    description: 'Reclaim disk: orphan data and old done sprints, previewed before anything is deleted.',
    hotkey: 'H',
    onSelect: (): void => input.onPushHome('housekeeping'),
  },
];

/** The stable navigation rows — work / observe / system — present regardless of loading state. */
const buildNavItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  ...buildWorkItems(input),
  ...buildObserveItems(input),
  ...buildSystemItems(input),
];

export const buildMenuItems = (input: BuildMenuItemsInput): readonly MenuItem[] => [
  ...buildAttentionItems(input),
  ...buildGetStartedItems(input),
  ...buildSwitchSprintItems(input),
  ...buildNavItems(input),
];
