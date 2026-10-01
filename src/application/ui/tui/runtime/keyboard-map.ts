/**
 * Centralised keyboard map. Every binding the TUI advertises lives in one of these maps so the
 * help overlay, status-bar hints, and global / view input handlers stay in sync. Adding a key is
 * a single edit here — the help overlay reflects it automatically.
 *
 * Two layers:
 *   - {@link globalKeys} — always-on, available from any view (with a few suspensions, e.g. while
 *     a prompt is mounted).
 *   - {@link listKeys} — applied wherever a vertical list with a moving cursor is rendered.
 *
 * Per-view local keys (e.g. `m=current` on the projects screen) are declared inline by each view via
 * the `useViewKeys` hook — they are not in the global map.
 */

import type { ViewKeyBinding } from '@src/application/ui/tui/runtime/use-view-keys.ts';

export interface KeyBinding {
  /** All accepted variants for this action (printable chars + special keys). */
  readonly keys: readonly string[];
  /** One-line label shown in the help overlay. */
  readonly label: string;
}

/**
 * Global bindings — available on every view. Conflict-free across the union below.
 *
 * None of these is advertised in the footer by key: the footer carries view-local keys plus the
 * handful of globals {@link buildFooterGlobalHints} derives from where you are (`esc <parent>`,
 * `1–5 sections`, `? help`, `q quit`). The letters below (`h n x s ! S P g`) are hidden
 * accelerators — they work everywhere and are listed under Global in `?`, but the tab bar's five
 * sections are what the UI teaches.
 */
export const globalKeys = {
  back: { keys: ['esc'], label: 'back — up one level, or to Work from a section root' },
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
 * The globals the footer advertises, in priority order (after the view-local keys): `esc <parent>`,
 * `1–5 sections` (wide only), `? help`, `q quit` (Work root only). Derived from where the operator
 * is, so the footer never offers an `esc` that does nothing or a `q` that does not quit.
 *
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

/**
 * Bindings local to the context switcher overlay — the project / sprint list mounted from `S` / `P`.
 *
 * `t` toggles between "all projects" (the default) and the current project only. Free across
 * the global / list / execute / tasks-panel maps. Surfaced here so the help overlay groups
 * the switcher's view-local keys alongside the rest of its bindings.
 */
export const switcherKeys = {
  toggleScope: { keys: ['t'], label: 'toggle project scope' },
  // `f` (filter), NOT `d`: `d` double-fires with the StatusBanner dismiss and means
  // delete-with-confirm in every sibling list view. Plain `f` is unused TUI-wide.
  hideDone: { keys: ['f'], label: 'hide done sprints' },
  create: { keys: ['c', '+'], label: 'new sprint in the current project' },
  close: { keys: ['esc'], label: 'close — never navigates' },
} as const satisfies Record<string, KeyBinding>;

/**
 * Contextual bindings — active only when a focused row supports the action. Surfaced in the
 * help overlay so the operator knows the chord exists; gated per-view by checking the focused
 * entity / field. `e` is the universal "fix a typo" shortcut for Project, Sprint, Ticket, Task,
 * and Repository entity fields. It overlaps with the Tasks-panel's `e` (expand done criteria) by
 * design — those keys live on different surfaces (browse views vs the live execute view) and
 * never collide at runtime.
 *
 * `u` resets a stuck task to `todo`. "Stuck" covers `blocked` (maxAttempts exhausted / verify
 * failed) and `in_progress` with a settled last attempt (crash recovery after Ctrl-C / watchdog
 * kill). Only active when the cursor is on a blocked or crashed-in-progress task in the
 * sprint-detail view.
 *
 * `c` (alias `+`) creates: a sprint on Work, Sprints and the context switcher, a project on Projects. `m` on the sprint-detail view marks the
 * opened sprint as the current selection — replaces the prior silent auto-sync on detail mount.
 * The same chord on the projects list / project detail marks the focused (or viewed) project
 * current — opening a project detail is a browse and never switches the selection.
 *
 * The Skills catalog view reuses `e` / `d` / `u` for enable / disable / update — another
 * deliberate overlap (see the `e` note above): these only fire on the Skills screen, which has
 * no Project/Sprint/Ticket field to edit and no stuck task to unblock, so the two meanings never
 * collide at runtime. `U` (update-all) is unique to that view.
 */
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
 * Vertical-list bindings — the canonical windowed-list navigation contract (see DESIGN-SYSTEM.md
 * § 6.4). Applied wherever a vertical list with a moving cursor is rendered, via the
 * `useListWindow` primitive. Four key groups: arrows (primary move), j/k (vim alias for move),
 * PgUp/PgDn (page), Home/End (jump first / last). Arrows are advertised per-view; j/k are a global
 * alias shown only here in the help overlay, not in per-view hints.
 *
 * NOTE: `g`/`G` vim aliases are absent — `g` is bound globally to the progress overlay (see
 * `globalKeys.progressOverlay`). Binding `g` here would cause it to both move the cursor to the
 * first item AND open the progress overlay on any list surface where a sprint is selected.
 * Home/End cover the jump-to-first/last ground without the conflict.
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

/**
 * Page-scroll bindings of the `ScrollRegion` (the middle slot of every view). Arrows also scroll
 * the page when a view doesn't own a list cursor, but they are the list contract's keys and are
 * listed under Lists. No printable key may appear here AND in {@link globalKeys} — `g` in particular
 * is the global progress-overlay toggle, which is why there is no vim-style `g` / `G` jump.
 */
export const scrollKeys = {
  page: { keys: ['PgUp', 'PgDn', 'Ctrl+b', 'Ctrl+f'], label: 'scroll page' },
  half: { keys: ['Ctrl+u', 'Ctrl+d'], label: 'scroll half page' },
  ends: { keys: ['Home', 'End'], label: 'scroll to top / bottom' },
} as const satisfies Record<string, KeyBinding>;

/**
 * Bindings owned by the execute view. `cancel` / `detach` are live only while the chain is
 * running; `rerun` is the mirror image — live only once it has settled, so the two halves never
 * contend for a keystroke.
 *
 * `r` resets to Flows rather than relaunching the finished flow: Flows re-evaluates every launch
 * trigger against the sprint's CURRENT status, so a sprint the run moved on offers the flow that
 * follows instead of a stale repeat. It collides with nothing global (`r` is a view-local reload /
 * primary-action letter across the browse views, never a global chord).
 */
export const executeKeys = {
  cancel: { keys: ['c'], label: 'cancel run (while running)' },
  detach: { keys: ['D'], label: 'detach (background)' },
  rerun: { keys: ['r'], label: 're-run from Flows (once settled)' },
  copyTask: { keys: ['y'], label: 'copy the active task summary (Execute only)' },
} as const satisfies Record<string, KeyBinding>;

/**
 * Bindings local to the Tasks panel — the live per-task surface on the Implement view.
 *
 * Cursor model: j / k (or ↑ / ↓) move within the focused card's signal rows when the card is
 * expanded; when the focused card is collapsed (or the row cursor is at an edge), the same
 * keystroke shifts the cursor between cards. This lets the operator pan between cards without
 * first collapsing them.
 *
 * `criteria` uses `e` (expand). The first instinct — `D` / Shift+D — collides with
 * {@link executeKeys.detach}, which the execute view intercepts regardless of whether the
 * panel owns input; `c` is the cancel binding. `e` is otherwise free across the global / list
 * / execute key surfaces and reads as "expand criteria" at a glance.
 *
 * `evaluation` uses `v` (verdict), shared with {@link contextualKeys.openEvaluation} on
 * sprint-detail — the same deliberate overlap as `e` above, and for the same reason: the live
 * Execute view and the sprint-detail browse view are never mounted at once, so the two `v`
 * handlers cannot both see a keystroke. (Work binds a third, equally disjoint `v`.)
 * OPENING is view-local because only a view knows which card the cursor is on; CLOSING is global
 * (`use-global-keys`) so `esc` / `v` beat the hidden view's handler.
 *
 * `criteria` and `evaluation` both anchor on the FOCUSED card — expanding criteria or reading a
 * verdict are both things an operator does about a card they've deliberately moved the cursor
 * onto (falling back to the active task while nothing is focused yet).
 *
 * `unblock` reuses {@link contextualKeys.unblockTask}'s label rather than restating it — same `u`
 * chord as sprint-detail / sprints-view, same "stuck task" concept, just reachable without
 * leaving the live Execute view. It is gated per-card (only fires on a card the host reports as
 * blocked) so it never contends with sprint-detail's `u`: the two views are never mounted at once.
 */
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
 * The view-local key vocabulary. Views declare their keys through `useViewKeys`; these builders
 * keep the spelling identical everywhere so the footer teaches one language.
 *
 *   - {@link listMoveBinding} — the documentation-only `↑/↓ move` entry for lists whose cursor
 *     lives in the windowed-list primitive. `j` / `k` are the silent alias (help overlay only).
 *   - {@link createBindings} — `c create`, with `+` as a silent alias. `n` is never "create":
 *     globally it opens the Flows menu.
 *
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
  /**
   * Route ids (`ViewId`s) whose screens actually mount the surface this section describes. The
   * help overlay hides the section elsewhere unless the operator asks for 'All keys'. Absent →
   * general, shown everywhere.
   */
  readonly onlyOn?: readonly string[];
  /**
   * Each entry is rendered by the help overlay. When `keys` is non-empty the entry is a
   * key-action pair (left column: chord, right column: `label`). When `keys` is empty the entry
   * is a reference row (left column: `label`, right column: `description`) — used for the
   * Signals legend so the static signal-kind vocabulary lives in the help overlay instead of
   * on every render of the Tasks panel.
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

/**
 * Signal-kind vocabulary surfaced in the help overlay. Mirrors `SIGNAL_LABEL_COLOR` in
 * `tasks-panel.tsx` — that map remains the colour source of truth; the overlay imports it via
 * the inline-kinds bar component. Descriptions are short, no trailing period (matches the
 * keybinding labels). Order tracks the operator's reading flow (most common first).
 */
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
