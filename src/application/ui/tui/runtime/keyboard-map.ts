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
}

/** Global bindings — available on every view. Conflict-free across the union below. */
export const globalKeys = {
  back: { keys: ['esc'], label: 'back' },
  home: { keys: ['h'], label: 'home' },
  flows: { keys: ['n'], label: 'new flow' },
  sessions: { keys: ['x'], label: 'sessions' },
  settings: { keys: ['s'], label: 'settings' },
  doctor: { keys: ['!'], label: 'doctor' },
  help: { keys: ['?'], label: 'help' },
  quit: { keys: ['q', 'ctrl+c'], label: 'quit' },
} as const satisfies Record<string, KeyBinding>;

/** Vertical-list bindings — used by every list view + action menu. */
export const listKeys = {
  up: { keys: ['↑', 'k'], label: 'up' },
  down: { keys: ['↓', 'j'], label: 'down' },
  pageUp: { keys: ['pgup'], label: 'page up' },
  pageDown: { keys: ['pgdn'], label: 'page down' },
  top: { keys: ['g'], label: 'top' },
  bottom: { keys: ['G'], label: 'bottom' },
  select: { keys: ['↵'], label: 'select' },
} as const satisfies Record<string, KeyBinding>;

/** Bindings shown specifically while a chain is running on the execute view. */
export const executeKeys = {
  cancel: { keys: ['c'], label: 'cancel run' },
  detach: { keys: ['D'], label: 'detach (background)' },
} as const satisfies Record<string, KeyBinding>;

export type GlobalKey = keyof typeof globalKeys;
export type ListKey = keyof typeof listKeys;
export type ExecuteKey = keyof typeof executeKeys;

/** Key labels grouped by area — consumed by the help overlay. */
export interface KeySection {
  readonly title: string;
  readonly bindings: ReadonlyArray<{ readonly keys: readonly string[]; readonly label: string }>;
}

const toSection = (title: string, map: Readonly<Record<string, KeyBinding>>): KeySection => ({
  title,
  bindings: Object.values(map),
});

export const keySections: readonly KeySection[] = [
  toSection('Global', globalKeys),
  toSection('Lists', listKeys),
  toSection('Execute', executeKeys),
];
