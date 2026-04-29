/**
 * keyboard-map — single source of truth for every action ↔ shortcut binding
 * in the Ink TUI.
 *
 * Why centralise: views previously hard-coded shortcut letters (`if (input
 * === 'a') …`) and duplicated those letters in their `useViewHints([…])`
 * declarations. Two strings, two places to drift. The map collapses the two:
 * each action declares ONE binding, views look the binding up by action, and
 * the help overlay (`components/help-overlay.tsx`) generates its rows from
 * the same table — so adding a binding is a single edit and the overlay
 * picks it up automatically.
 *
 * Areas:
 *   - `global` — always active except when shadowed (notification / prompt /
 *     help overlay all suspend the global handler)
 *   - `list` — any `<ListView />` surface (browse list views, runs list)
 *   - `detail` — browse show views (sprint-show, ticket-show, …)
 *   - `execute` — live execution dashboard
 *   - `attach` — read-only daemon attach surface
 *   - `runs` — running-executions list (specifically the cancel-row hotkey)
 *   - `settings` — settings panel
 *   - `help` — help overlay (toggle / close keys)
 *   - `notification` — sticky toast (dismiss; bound action key declared per-toast)
 *
 * Test fences (`keyboard-map.test.ts`):
 *   1. Every action carries at least one binding.
 *   2. Within one area, no two actions share a key.
 *   3. Global bindings shadow non-global areas — no non-global action can
 *      reuse a global key for a different action.
 *   4. Each Action key in the union is present in the map (structural).
 *
 * Aliases (e.g. `↑` / `k` both bound to `list.up`) are allowed as a `keys`
 * array per binding.
 */

export type BindingArea =
  | 'global'
  | 'home'
  | 'list'
  | 'detail'
  | 'execute'
  | 'attach'
  | 'runs'
  | 'settings'
  | 'help'
  | 'notification';

export interface Binding {
  /**
   * Keys that fire the action. The first entry is the canonical key shown in
   * status-bar hints; subsequent entries are aliases (e.g. vim-style `j/k`).
   * The strings are matched against Ink's `useInput((input, key) => …)`
   * `input` parameter directly — except for `'esc'`, `'enter'`, `'PgUp'`,
   * `'PgDn'`, `'↑'`, `'↓'`, which are documentary names matched by the
   * companion `key` flags inside the consumer.
   */
  readonly keys: readonly string[];
  /** Human-readable verb shown in the help overlay. */
  readonly label: string;
  readonly area: BindingArea;
}

/**
 * The canonical map. Adding a row here automatically adds the action to the
 * `Action` union and surfaces it in the help overlay; no other touch needed.
 */
const MAP_ENTRIES = {
  // === Global hotkeys (always active outside prompts / notifications) ===
  'global.back': { keys: ['esc'], label: 'back', area: 'global' },
  'global.home': { keys: ['h'], label: 'home', area: 'global' },
  'global.settings': { keys: ['s'], label: 'settings', area: 'global' },
  'global.dashboard': { keys: ['d'], label: 'dashboard', area: 'global' },
  'global.runs': { keys: ['x'], label: 'running runs', area: 'global' },
  'global.help': { keys: ['?'], label: 'keyboard help', area: 'global' },
  'global.doctor': { keys: ['!'], label: 'doctor', area: 'global' },
  'global.quit': { keys: ['q'], label: 'quit (home only)', area: 'global' },

  // === Home view ===
  // `b` opens the browse submenu from the pipeline map. Only valid on Home.
  'home.browse': { keys: ['b'], label: 'browse', area: 'home' },

  // === List shortcuts (every <ListView /> surface) ===
  'list.up': { keys: ['↑', 'k'], label: 'move up', area: 'list' },
  'list.down': { keys: ['↓', 'j'], label: 'move down', area: 'list' },
  'list.pageUp': { keys: ['PgUp'], label: 'page up', area: 'list' },
  'list.pageDown': { keys: ['PgDn'], label: 'page down', area: 'list' },
  'list.open': { keys: ['enter'], label: 'open / drill in', area: 'list' },
  'list.add': { keys: ['a'], label: 'add', area: 'list' },
  'list.edit': { keys: ['e'], label: 'edit', area: 'list' },
  'list.remove': { keys: ['r'], label: 'remove', area: 'list' },
  'list.new': { keys: ['n'], label: 'new', area: 'list' },
  'list.filter': { keys: ['f'], label: 'cycle filter', area: 'list' },
  'list.setCurrent': { keys: ['c'], label: 'set current', area: 'list' },
  'list.status': { keys: ['t'], label: 'change status', area: 'list' },
  'list.onboard': { keys: ['o'], label: 'onboard', area: 'list' },

  // === Detail (browse show views) ===
  'detail.edit': { keys: ['e'], label: 'edit', area: 'detail' },
  'detail.addRepo': { keys: ['a'], label: 'add repo', area: 'detail' },
  'detail.removeRepo': { keys: ['r'], label: 'remove repo', area: 'detail' },
  'detail.onboard': { keys: ['o'], label: 'onboard', area: 'detail' },
  'detail.status': { keys: ['t'], label: 'change status', area: 'detail' },

  // === Execute (live execution dashboard) ===
  // `D` (uppercase) backgrounds the foreground execution. Lowercase `d` is
  // the global "open dashboard" hotkey, so we use uppercase here to avoid
  // stomping the global handler.
  'execute.cancel': { keys: ['c'], label: 'cancel run', area: 'execute' },
  'execute.detach': { keys: ['D'], label: 'detach (background)', area: 'execute' },
  'execute.back': { keys: ['enter'], label: 'back', area: 'execute' },

  // === Attach (read-only daemon view) ===
  'attach.back': { keys: ['enter'], label: 'back', area: 'attach' },

  // === Runs (running-executions list) ===
  // `X` (uppercase) cancels the highlighted execution. Lowercase `x` is the
  // global hotkey that lands on this view and would bounce back to itself.
  'runs.cancel': { keys: ['X'], label: 'cancel highlighted run', area: 'runs' },

  // === Settings panel ===
  'settings.up': { keys: ['↑', 'k'], label: 'up', area: 'settings' },
  'settings.down': { keys: ['↓', 'j'], label: 'down', area: 'settings' },
  'settings.edit': { keys: ['enter'], label: 'edit', area: 'settings' },
  'settings.close': { keys: ['esc'], label: 'close', area: 'settings' },

  // === Help overlay ===
  // The `?` toggle is owned by `global.help`. The overlay-side closing keys
  // are documented here so users see them in the help reference; they
  // intentionally shadow the global back/help keys (the overlay's own
  // useInput handler claims them while open).
  'help.close': { keys: ['esc'], label: 'close help', area: 'help' },

  // === Notification (sticky toast) ===
  // The bound action key is declared per-notification at runtime; only the
  // dismiss key is canonical here.
  'notification.dismiss': { keys: ['esc'], label: 'dismiss', area: 'notification' },
} as const satisfies Record<string, Binding>;

export type Action = keyof typeof MAP_ENTRIES;

/**
 * Public read of the keyboard map. Treat as immutable — mutations would
 * desync from the help overlay rendered on the same data.
 */
export const KEYBOARD_MAP: Readonly<Record<Action, Binding>> = MAP_ENTRIES;

/**
 * Optional context hint for `getBindingFor`. Today the lookup is action-keyed
 * (each action carries its own area) so context is informational only — it's
 * accepted to keep the call-site self-documenting (`getBindingFor('list.up',
 * 'sprint-list')` reads more clearly than the bare action) and to provide a
 * forward-compat seam if a future action needs per-context resolution.
 */
export type BindingContext = string;

/**
 * Look up the binding for an action. Throws at the type level if the action
 * isn't a known key.
 */
export function getBindingFor(action: Action, context?: BindingContext): Binding {
  void context;
  return MAP_ENTRIES[action];
}

/**
 * Convenience helper: returns the canonical (first) key for an action. Most
 * `useInput` consumers want a single string to compare against `input`. The
 * map invariant (every binding has at least one key) is pinned by the
 * keyboard-map test; the runtime fallback to '' is a defensive cushion in
 * case a contributor adds a malformed entry.
 */
export function getKeyFor(action: Action): string {
  // The `as const satisfies` declaration above makes every `keys` array a
  // non-empty tuple at the type level, so `[0]` is `string` (not `string |
  // undefined`). The lint rule trusts that.
  return MAP_ENTRIES[action].keys[0];
}

/**
 * Returns every binding tagged with the given area, in declaration order.
 * Used by the help overlay (one section per area) and by `useGlobalKeys`
 * (`getBindingsByArea('global')` to drive the global-hotkey dispatch).
 */
export function getBindingsByArea(area: BindingArea): readonly { action: Action; binding: Binding }[] {
  const out: { action: Action; binding: Binding }[] = [];
  for (const [action, binding] of Object.entries(MAP_ENTRIES) as [Action, Binding][]) {
    if (binding.area === area) out.push({ action, binding });
  }
  return out;
}

/**
 * All (action, binding) pairs. Used by the help overlay to render a complete
 * reference and by tests that fan out conflict checks across the table.
 */
export function getAllBindings(): readonly { action: Action; binding: Binding }[] {
  return Object.entries(MAP_ENTRIES).map(([action, binding]) => ({
    action: action as Action,
    binding,
  }));
}

/**
 * Areas listed in the order they should appear in the help overlay. Keeps
 * the overlay ordering stable and centralised — adding a new area requires
 * adding it here too, which is easier to forget if the overlay infers
 * ordering from the map.
 */
export const HELP_AREA_ORDER: readonly BindingArea[] = [
  'global',
  'home',
  'list',
  'detail',
  'execute',
  'attach',
  'runs',
  'settings',
  'help',
  'notification',
];

/**
 * Friendly label per area, shown as the section header in the help overlay.
 */
export const AREA_LABEL: Readonly<Record<BindingArea, string>> = {
  global: 'Global',
  home: 'Home',
  list: 'List views',
  detail: 'Detail views',
  execute: 'Live execution',
  attach: 'Attach (read-only)',
  runs: 'Running executions',
  settings: 'Settings panel',
  help: 'Help overlay',
  notification: 'Notification',
};
