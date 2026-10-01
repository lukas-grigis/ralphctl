/** Centralised keyboard map. */

import type { ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';

export interface KeyBinding {
  /** All accepted variants for this action (printable chars + special keys). */
  readonly keys: readonly string[];
  /** One-line label shown in the help overlay. */
  readonly label: string;
}

/** Global bindings — available on every view. Conflict-free across the union below. */
export const globalKeys = {
  back: { keys: ['esc'], label: 'back — up one level, or to Work from a root' },
  sections: { keys: ['1', '2', '3', '4', '5'], label: 'jump to Work / Sprints / Projects / Runs / System' },
  home: { keys: ['h'], label: 'Work, reset to its root' },
  flows: { keys: ['n'], label: 'flows (Work, flow list focused)' },
  cycleSession: { keys: ['Tab', 'Shift+Tab'], label: 'cycle running flow' },
  jumpSession: { keys: ['Ctrl+1..9'], label: 'jump to running flow (kitty-protocol term)' },
  sessions: { keys: ['x'], label: 'Runs' },
  settings: { keys: ['s'], label: 'System › Settings' },
  doctor: { keys: ['!'], label: 'System › Doctor' },
  progressOverlay: { keys: ['g'], label: 'show progress.md' },
  switchSprint: { keys: ['S'], label: 'switch sprint (and project)' },
  switchProject: { keys: ['P'], label: 'switch project' },
  help: { keys: ['?'], label: 'help' },
  quit: { keys: ['q', 'ctrl+c'], label: 'quit (q on the Work root)' },
} as const satisfies Record<string, KeyBinding>;

/** A footer cell: the keys as typed and a one-word action. */
export interface FooterGlobalHint {
  readonly keys: string;
  readonly label: string;
}

export interface FooterGlobalsInput {
  /** The active section's stack depth. */
  readonly stackDepth: number;
  /** Display label of the entry below the top of the stack (`Sprints`), when the stack is deeper than 1. */
  readonly parentLabel: string | undefined;
  /** The Work section's root view is showing — the only place `q` quits. */
  readonly onWorkRoot: boolean;
  /** A section other than Work (or none) is at its root: `esc` goes to Work. */
  readonly atOtherSectionRoot: boolean;
  /** Terminal is at least `lg` wide — room for the `1–5 sections` reminder. */
  readonly wide: boolean;
}

/**
 * The globals the footer advertises, in priority order (after the view-local keys): `esc <parent>`, `1–5 sections`
 * (wide only), `? help`, `q quit` (Work root only).
 * @public
 */
export const buildFooterGlobalHints = (input: FooterGlobalsInput): readonly FooterGlobalHint[] => {
  const hints: FooterGlobalHint[] = [];
  if (input.stackDepth > 1 && input.parentLabel !== undefined) {
    hints.push({ keys: globalKeys.back.keys[0], label: input.parentLabel });
  } else if (input.atOtherSectionRoot) {
    hints.push({ keys: globalKeys.back.keys[0], label: 'work' });
  }
  if (input.wide) hints.push({ keys: '1–5', label: 'sections' });
  hints.push({ keys: globalKeys.help.keys[0], label: globalKeys.help.label });
  if (input.onWorkRoot) hints.push({ keys: globalKeys.quit.keys.join('/'), label: 'quit' });
  return hints;
};

/** Bindings local to the context switcher overlay — the project / sprint list mounted from `S` / `P`. */
export const switcherKeys = {
  toggleScope: { keys: ['t'], label: 'toggle project scope' },
  // `f` (filter), NOT `d`: `d` double-fires with the StatusBanner dismiss and means
  // delete-with-confirm in every sibling list view. Plain `f` is unused TUI-wide.
  hideDone: { keys: ['f'], label: 'hide done sprints' },
  create: { keys: ['c', '+'], label: 'new sprint in the current project' },
  close: { keys: ['esc'], label: 'close — never navigates' },
} as const satisfies Record<string, KeyBinding>;

/** Contextual bindings — active only when a focused row supports the action. */
export const contextualKeys = {
  editField: { keys: ['e'], label: 'edit focused field' },
  unblockTask: { keys: ['u'], label: 'unblock stuck task (blocked or crashed in-progress)' },
  bulkUnblockSprintTasks: { keys: ['u'], label: 'unblock all stuck tasks in focused sprint' },
  create: { keys: ['c', '+'], label: 'create (sprint / project) — `+` is a silent alias' },
  makeSprintCurrent: { keys: ['m'], label: 'make focused sprint current' },
  makeProjectCurrent: { keys: ['m'], label: 'make focused project current' },
  enableSkill: { keys: ['e'], label: 'enable skill for picked flows' },
  disableSkill: { keys: ['d'], label: 'disable skill for picked flows' },
  updateSkill: { keys: ['u'], label: 'update skill from bundle' },
  updateAllSkills: { keys: ['U'], label: 'update every out-of-date skill' },
  openEvaluation: { keys: ['v'], label: "open the focused task's evaluation verdict" },
  toggleBanner: { keys: ['b'], label: 'toggle the wordmark banner (Work only)' },
  reloadFromDisk: { keys: ['r'], label: 're-read the sprint list / sprint detail from disk' },
} as const satisfies Record<string, KeyBinding>;

/**
 * Vertical-list bindings — the canonical windowed-list navigation contract (see DESIGN-SYSTEM.md § 6.4).
 */
export const listKeys = {
  up: { keys: ['↑', 'k'], label: 'up' },
  down: { keys: ['↓', 'j'], label: 'down' },
  pageUp: { keys: ['PgUp'], label: 'page up' },
  pageDown: { keys: ['PgDn'], label: 'page down' },
  top: { keys: ['Home'], label: 'first' },
  bottom: { keys: ['End'], label: 'last' },
  select: { keys: ['↵'], label: 'select' },
} as const satisfies Record<string, KeyBinding>;

/** Page-scroll bindings of the `ScrollRegion` (the middle slot of every view). */
export const scrollKeys = {
  page: { keys: ['PgUp', 'PgDn', 'Ctrl+b', 'Ctrl+f'], label: 'scroll page' },
  half: { keys: ['Ctrl+u', 'Ctrl+d'], label: 'scroll half page' },
  ends: { keys: ['Home', 'End'], label: 'scroll to top / bottom' },
} as const satisfies Record<string, KeyBinding>;

/** Bindings owned by the execute view. */
export const executeKeys = {
  cancel: { keys: ['c'], label: 'cancel run (while running)' },
  detach: { keys: ['D'], label: 'detach (background)' },
  rerun: { keys: ['r'], label: 're-run from Work (once settled)' },
  copyTask: { keys: ['y'], label: 'copy the active task summary (Execute only)' },
} as const satisfies Record<string, KeyBinding>;

/** Bindings local to the Tasks panel — the live per-task surface on the Implement view. */
export const tasksPanelKeys = {
  navUp: { keys: ['k', '↑'], label: 'prev card / row' },
  navDown: { keys: ['j', '↓'], label: 'next card / row' },
  toggleCard: { keys: ['↵', 'space'], label: 'expand / collapse card or commit row' },
  collapseCard: { keys: ['esc'], label: 'collapse expanded card' },
  criteria: { keys: ['e'], label: 'expand done criteria for focused card' },
  evaluation: { keys: ['v'], label: 'open evaluation verdict for the focused card' },
  unblock: { keys: ['u'], label: contextualKeys.unblockTask.label },
} as const satisfies Record<string, KeyBinding>;

/**
 * The view-local key vocabulary.
 * @public
 */
export const listMoveBinding: ViewKeyBinding = { keys: ['↑', '↓'], hint: 'move' };

/** @public */
export const createBindings = (run: () => void, enabled?: boolean): readonly ViewKeyBinding[] => [
  { keys: ['c'], hint: 'create', ...(enabled !== undefined ? { enabled } : {}), run },
  { keys: ['+'], hint: 'create', hidden: true, ...(enabled !== undefined ? { enabled } : {}), run },
];

/** Key labels grouped by area — consumed by the help overlay. */
export interface KeySection {
  readonly title: string;
  /** Route ids (`ViewId`s) whose screens actually mount the surface this section describes. */
  readonly onlyOn?: readonly string[];
  /**
   * Each entry is rendered by the help overlay. When `keys` is non-empty the entry is a key-action pair (left column:
   * chord, right column: `label`).
   */
  readonly bindings: ReadonlyArray<{
    readonly keys: readonly string[];
    readonly label: string;
    readonly description?: string;
    /** Optional truecolor swatch for the left-column label on reference rows. */
    readonly color?: string;
  }>;
}

const toSection = (
  title: string,
  map: Readonly<Record<string, KeyBinding>>,
  onlyOn?: readonly string[]
): KeySection => ({
  title,
  bindings: Object.values(map),
  ...(onlyOn !== undefined ? { onlyOn } : {}),
});

/** Signal-kind vocabulary surfaced in the help overlay. */
const signalReference: KeySection = {
  title: 'Signals',
  onlyOn: ['execute'],
  bindings: [
    { keys: [], label: 'change', description: 'file or code edit made by the AI during a task' },
    { keys: [], label: 'learning', description: 'cross-task insight worth noting' },
    { keys: [], label: 'decision', description: 'design choice the AI committed to' },
    { keys: [], label: 'verified', description: 'task self-check gate passed' },
    { keys: [], label: 'blocked', description: 'task halted — check gate failed or AI self-reported stuck' },
    { keys: [], label: 'commit', description: 'proposed commit message for the task' },
    { keys: [], label: 'note', description: 'general annotation' },
    { keys: [], label: 'script', description: 'setup or check script discovered or run' },
    { keys: [], label: 'proposal', description: 'AI-authored context file or skill draft' },
    { keys: [], label: 'skills', description: 'skill suggestions surfaced for this run' },
    { keys: [], label: 'reproduce', description: 'failing test written to demonstrate a reported defect' },
    { keys: [], label: 'judge', description: 'best-of-N candidate comparison verdict' },
  ],
};

export const keySections: readonly KeySection[] = [
  toSection('Global', globalKeys),
  toSection('Lists', listKeys),
  toSection('Scroll', scrollKeys),
  toSection('Contextual', contextualKeys),
  // The switcher is an overlay, not a route: `?` replaces it, so its keys surface under 'All keys'.
  toSection('Context switcher', switcherKeys, []),
  toSection('Execute', executeKeys, ['execute']),
  toSection('Tasks panel', tasksPanelKeys, ['execute']),
  signalReference,
];
