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
 * Per-view local hints (e.g. `n=new` on the projects screen) are declared inline by each view via
 * the {@link useViewHints} hook — they are not in the global map.
 */

export interface KeyBinding {
  /** All accepted variants for this action (printable chars + special keys). */
  readonly keys: readonly string[];
  /** One-line label shown in the help overlay and (selectively) in the status bar. */
  readonly label: string;
  /**
   * When `true`, this binding is also surfaced in the always-visible status-bar footer (via
   * {@link footerGlobalHints}) — the curated subset of global chords worth advertising on every
   * screen. Absent / `false` keeps the binding in the help overlay only.
   */
  readonly showInFooter?: boolean;
}

/**
 * Global bindings — available on every view. Conflict-free across the union below.
 *
 * Bindings tagged `showInFooter` are mirrored into the status-bar footer via
 * {@link footerGlobalHints}; the rest live in the help overlay only.
 */
export const globalKeys = {
  back: { keys: ['esc'], label: 'back', showInFooter: true },
  home: { keys: ['h'], label: 'home', showInFooter: true },
  flows: { keys: ['n'], label: 'new flow', showInFooter: true },
  cycleSession: { keys: ['Tab', 'Shift+Tab'], label: 'cycle running flow' },
  jumpSession: { keys: ['Ctrl+1..9'], label: 'jump to running flow (kitty-protocol term)' },
  sessions: { keys: ['x'], label: 'sessions', showInFooter: true },
  settings: { keys: ['s'], label: 'settings', showInFooter: true },
  doctor: { keys: ['!'], label: 'doctor' },
  bannerToggle: { keys: ['b'], label: 'toggle banner' },
  progressOverlay: { keys: ['g'], label: 'show progress.md' },
  yankTask: { keys: ['y'], label: 'copy active task summary' },
  pickProject: { keys: ['P'], label: 'pick project', showInFooter: true },
  // NOT showInFooter: with `pick sprint` added the strip overflows a 100-col terminal and the
  // whole footer wraps. The breadcrumb's `[S]` affordance (right next to the sprint name)
  // carries the discoverability instead.
  pickSprint: { keys: ['S'], label: 'pick sprint' },
  help: { keys: ['?'], label: 'help', showInFooter: true },
  quit: { keys: ['q', 'ctrl+c'], label: 'quit', showInFooter: true },
} as const satisfies Record<string, KeyBinding>;

/**
 * The curated subset of {@link globalKeys} surfaced in the always-visible status-bar footer,
 * pre-mapped to the footer's `{ keys, label }` hint shape (`keys` joined with `/` for
 * multi-variant bindings). Single source of truth for the footer's global hints — the status bar
 * renders this instead of hand-maintaining a parallel list.
 *
 * @public
 */
export const footerGlobalHints: ReadonlyArray<{ readonly keys: string; readonly label: string }> = (
  Object.values(globalKeys) as KeyBinding[]
)
  .filter((b) => b.showInFooter === true)
  .map((b) => ({ keys: b.keys.join('/'), label: b.label }));

/**
 * Bindings local to the sprint picker — the cross-project sprint list mounted from `S`.
 *
 * `t` toggles between "all projects" (the default) and the current project only. Free across
 * the global / list / execute / tasks-panel maps. Surfaced here so the help overlay groups
 * the picker's lone view-local key alongside the rest of its bindings.
 */
export const pickerKeys = {
  toggleScope: { keys: ['t'], label: 'toggle project scope' },
  // `f` (filter), NOT `d`: `d` double-fires with the StatusBanner dismiss mounted inside the
  // picker's ViewShell and means delete-with-confirm in every sibling list view. Plain `f` is
  // unused TUI-wide.
  hideDone: { keys: ['f'], label: 'hide done sprints' },
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
 * `+` on Home opens create-sprint (requires a project). `m` on the sprint-detail view marks the
 * opened sprint as the current selection — replaces the prior silent auto-sync on detail mount.
 * The same chord on the projects list / project detail marks the focused (or viewed) project
 * current — opening a project detail is a browse and never switches the selection.
 */
export const contextualKeys = {
  editField: { keys: ['e'], label: 'edit focused field' },
  unblockTask: { keys: ['u'], label: 'unblock stuck task (blocked or crashed in-progress)' },
  bulkUnblockSprintTasks: { keys: ['u'], label: 'unblock all stuck tasks in focused sprint' },
  createSprint: { keys: ['+'], label: 'create a new sprint' },
  makeSprintCurrent: { keys: ['m'], label: 'make focused sprint current' },
  makeProjectCurrent: { keys: ['m'], label: 'make focused project current' },
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

/** Bindings shown specifically while a chain is running on the execute view. */
export const executeKeys = {
  cancel: { keys: ['c'], label: 'cancel run' },
  detach: { keys: ['D'], label: 'detach (background)' },
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
 */
export const tasksPanelKeys = {
  navUp: { keys: ['k', '↑'], label: 'prev card / row' },
  navDown: { keys: ['j', '↓'], label: 'next card / row' },
  toggleCard: { keys: ['↵', 'space'], label: 'expand / collapse card or commit row' },
  collapseCard: { keys: ['esc'], label: 'collapse expanded card' },
  criteria: { keys: ['e'], label: 'expand done criteria for active card' },
} as const satisfies Record<string, KeyBinding>;

/**
 * The canonical `↑/↓ → move` hint for list views. Include this as the first entry in every
 * list view's `useViewHints` so the footer consistently teaches arrow navigation. Per the
 * windowed-list contract (DESIGN-SYSTEM §6.4), arrows are primary; `j`/`k` are documented in
 * the help overlay's Lists section only and must not be repeated per-view.
 *
 * @public
 */
export const listMoveHint: { readonly keys: string; readonly label: string } = {
  keys: '↑/↓',
  label: 'move',
};

/** Key labels grouped by area — consumed by the help overlay. */
export interface KeySection {
  readonly title: string;
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

const toSection = (title: string, map: Readonly<Record<string, KeyBinding>>): KeySection => ({
  title,
  bindings: Object.values(map),
});

/**
 * Signal-kind vocabulary surfaced in the help overlay. Mirrors `SIGNAL_LABEL_COLOR` in
 * `tasks-panel.tsx` — that map remains the colour source of truth; the overlay imports it via
 * the inline-kinds bar component. Descriptions are short, no trailing period (matches the
 * keybinding labels). Order tracks the operator's reading flow (most common first).
 */
const signalReference: KeySection = {
  title: 'Signals',
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
  ],
};

export const keySections: readonly KeySection[] = [
  toSection('Global', globalKeys),
  toSection('Lists', listKeys),
  toSection('Contextual', contextualKeys),
  toSection('Sprint picker', pickerKeys),
  toSection('Execute', executeKeys),
  toSection('Tasks panel', tasksPanelKeys),
  signalReference,
];
