/**
 * useGlobalKeys — centralises the router-level hotkeys so every view inherits
 * them regardless of its own `useInput` handlers.
 *
 * Global hotkeys are derived from `getBindingsByArea('global')` in
 * `keyboard-map.ts` — adding a new global key is a single edit to the map.
 *
 *   esc  → pop one frame (no-op at root)            global.back
 *   h    → reset to [home]                          global.home
 *   s    → push settings overlay                    global.settings
 *   d    → push dashboard                           global.dashboard
 *   x    → push sessions (running runs)             global.runs  (inert until runs view lands)
 *   ?    → toggle help overlay                      global.help  (handled by ViewRouter)
 *   !    → push doctor                              global.doctor (inert until doctor view lands)
 *   q    → exit (only when at home root)            global.quit
 *   Tab         → foreground next session
 *   Shift+Tab   → foreground previous session
 *   Ctrl+1..9   → foreground n-th session
 *
 * Prompts disable the hook while they are pending — the prompt's own
 * useInput handler owns the keyboard until it resolves.
 *
 * The help overlay is wired in `view-router.tsx` (`isHelpOpen` state). This
 * hook fires `onToggleHelp` for the `?` binding; when the overlay is open,
 * `ViewRouter` sets `isActive: false` here to prevent double-handling.
 */

import { useApp, useInput } from 'ink';
import { useCurrentPrompt } from '@src/integration/ui/prompts/hooks.ts';
import { useRouterOptional, type ViewId } from './router-context.ts';
import { getKeyFor } from '@src/application/tui/keyboard-map.ts';
import type { SessionManagerPort } from '@src/application/runtime/session-manager-port.ts';

interface Options {
  readonly sessionManager?: SessionManagerPort | null;
  /** Called when the `?` global.help key fires. */
  readonly onToggleHelp?: () => void;
  /**
   * When true the hook is inactive (e.g. the help overlay is open and
   * owns the keyboard itself).
   */
  readonly suspended?: boolean;
}

function isSessionManager(
  v: SessionManagerPort | null | Options | undefined
): v is SessionManagerPort | null | undefined {
  if (v == null) return true;
  return 'list' in v && 'start' in v;
}

export function useGlobalKeys(sessionManagerOrOptions?: SessionManagerPort | null | Options): void {
  // Accept either the bare `sessionManager` positional arg or the
  // options bag, so existing call sites don't need to migrate at once.
  let sessionManager: SessionManagerPort | null | undefined;
  let onToggleHelp: (() => void) | undefined;
  let suspended = false;

  if (isSessionManager(sessionManagerOrOptions)) {
    sessionManager = sessionManagerOrOptions;
  } else {
    const opts = sessionManagerOrOptions;
    sessionManager = opts.sessionManager;
    onToggleHelp = opts.onToggleHelp;
    suspended = opts.suspended ?? false;
  }

  const router = useRouterOptional();
  const app = useApp();
  const currentPrompt = useCurrentPrompt();

  // Disable the handler outright when the router is not mounted (view unit
  // tests render individual views without a <ViewRouter />) or while a
  // prompt owns the keyboard or the help overlay is open.
  const active = router !== null && currentPrompt === null && !suspended;

  // Canonical key strings from the keyboard map.
  const KEY_BACK = getKeyFor('global.back');
  const KEY_HOME = getKeyFor('global.home');
  const KEY_SETTINGS = getKeyFor('global.settings');
  const KEY_DASHBOARD = getKeyFor('global.dashboard');
  const KEY_RUNS = getKeyFor('global.runs');
  const KEY_HELP = getKeyFor('global.help');
  const KEY_DOCTOR = getKeyFor('global.doctor');
  const KEY_QUIT = getKeyFor('global.quit');

  useInput(
    (input, key) => {
      if (router === null) return;

      // ── Esc / back ────────────────────────────────────────────────────
      if (key.escape || input === KEY_BACK) {
        router.pop();
        return;
      }

      // ── Named global hotkeys ─────────────────────────────────────────
      if (input === KEY_HOME) {
        router.reset({ id: 'home' });
        return;
      }

      const currentViewId: ViewId = router.current.id;

      if (input === KEY_SETTINGS && currentViewId !== 'settings') {
        router.push({ id: 'settings' });
        return;
      }
      if (input === KEY_DASHBOARD && currentViewId !== 'dashboard') {
        router.push({ id: 'dashboard' });
        return;
      }
      // global.runs — navigates to sessions view (runs list)
      // Inert no-op if the sessions view doesn't exist; just push and let the
      // router handle it gracefully. Listed in the keyboard-map for visibility.
      if (input === KEY_RUNS && currentViewId !== 'sessions') {
        router.push({ id: 'sessions' });
        return;
      }
      // global.help — toggled in the router via onToggleHelp callback.
      if (input === KEY_HELP) {
        onToggleHelp?.();
        return;
      }
      // global.doctor — navigate to the doctor view.
      if (input === KEY_DOCTOR && currentViewId !== 'doctor') {
        router.push({ id: 'doctor' });
        return;
      }

      // ── Sessions switcher ──────────────────────────────────────────────
      // Helper: if we're already on the execute view, REPLACE the current
      // frame instead of pushing a new one — Tab cycling between three
      // sessions otherwise grew the back-stack to "Home › Execute › Execute
      // › Execute › Execute …" forever. Same logic for Ctrl+N direct-jump.
      const navigateToExecute = (sessionId: string): void => {
        const onExecute = router.current.id === 'execute';
        if (onExecute) {
          router.replace({ id: 'execute', props: { sessionId } });
        } else {
          router.push({ id: 'execute', props: { sessionId } });
        }
      };
      if (sessionManager) {
        // Tab = foreground next; Shift+Tab = foreground previous
        if (key.tab && !key.shift) {
          const sessions = sessionManager.list();
          if (sessions.length > 0) {
            const activeId = sessionManager.active?.id;
            const idx = activeId ? sessions.findIndex((s) => s.id === activeId) : -1;
            const next = sessions[(idx + 1) % sessions.length];
            if (next) {
              sessionManager.foreground(next.id);
              navigateToExecute(next.id);
            }
          }
          return;
        }
        if (key.tab && key.shift) {
          const sessions = sessionManager.list();
          if (sessions.length > 0) {
            const activeId = sessionManager.active?.id;
            const idx = activeId ? sessions.findIndex((s) => s.id === activeId) : sessions.length;
            const prev = sessions[(idx - 1 + sessions.length) % sessions.length];
            if (prev) {
              sessionManager.foreground(prev.id);
              navigateToExecute(prev.id);
            }
          }
          return;
        }
        // Ctrl+1..9
        if (key.ctrl && /^[1-9]$/.test(input)) {
          const n = parseInt(input, 10) - 1;
          const sessions = sessionManager.list();
          const target = sessions[n];
          if (target) {
            sessionManager.foreground(target.id);
            navigateToExecute(target.id);
          }
          return;
        }
      }

      // Quit — only from home root
      if (input === KEY_QUIT && router.stack.length === 1 && currentViewId === 'home') {
        app.exit();
      }
    },
    { isActive: active }
  );
}
