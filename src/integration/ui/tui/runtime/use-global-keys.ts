/**
 * useGlobalKeys — centralises the router-level hotkeys so every view inherits
 * them regardless of its own `useInput` handlers.
 *
 * Bindings come from the canonical map (`tui/keyboard-map.ts`). Adding,
 * renaming, or rebinding a global hotkey is a single edit to that file —
 * this hook stays a dispatcher.
 *
 * Previously the dispatch lived inside `ViewRouter` as a single `useInput`
 * call. In practice this meant that browse detail views (ticket-show,
 * task-show, …) — whose own `useInput` handlers sit deeper in the tree — could
 * mask the global key set under some Ink focus conditions. Pulling the
 * dispatch into a hook lets `ViewShell` install it at every wrapped view, so
 * the hotkeys fire consistently from any screen.
 *
 * While a prompt is pending the user is typing into an input field — we MUST
 * NOT intercept plain characters like `s`/`d`/`h`/`q` or Esc (which the prompt
 * uses to cancel). The prompt's own `useInput` handler owns the keyboard until
 * it resolves; disabling the hook via `isActive: false` is the cleanest way to
 * achieve that with Ink's multiplexed input model.
 *
 * When a sticky notification is on screen, Esc and any bound action key are
 * forwarded to the notification component instead of the router. Without this
 * the same keypress would fire both handlers — pressing the action key would
 * navigate AND keep the notification visible (or worse, navigate then auto-
 * dismiss after the action ran). The same pattern applies to the help
 * overlay: while it is open, `?` and Esc go to the overlay's own handler.
 */

import { useEffect, useState } from 'react';
import { useApp, useInput } from 'ink';
import { useCurrentPrompt } from '@src/integration/ui/prompts/hooks.ts';
import { useRouterOptional, type ViewId } from '@src/integration/ui/tui/views/router-context.ts';
import { clearHomeSubmenuMemory } from '@src/integration/ui/tui/views/home-submenu-memory.ts';
import { notificationBus, type Notification } from '@src/integration/ui/tui/runtime/notification-bus.ts';
import { getKeyFor, type Action } from '@src/integration/ui/tui/keyboard-map.ts';

/**
 * Tiny module-level event bus that lets the help overlay decouple its open
 * state from the router. The router subscribes and toggles `helpOpen`; the
 * global keys hook flips the bus on `?`. Single producer, single consumer
 * — the simplest workable shape.
 */
type HelpListener = () => void;

class HelpToggleBus {
  private state = false;
  private readonly listeners = new Set<HelpListener>();

  isOpen(): boolean {
    return this.state;
  }

  toggle(): void {
    this.state = !this.state;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // Listener errors are swallowed — a broken subscriber must not stall
        // the toggle for everyone else.
      }
    }
  }

  close(): void {
    if (!this.state) return;
    this.toggle();
  }

  subscribe(listener: HelpListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const helpToggleBus = new HelpToggleBus();

function useActiveNotification(): Notification | null {
  const [active, setActive] = useState<Notification | null>(() => notificationBus.current());
  useEffect(() => {
    return notificationBus.subscribe(setActive);
  }, []);
  return active;
}

/**
 * Subscribe to the help-overlay open state. Mirrors `useActiveNotification`
 * — single source of truth (`helpToggleBus`) drives both the overlay's
 * mount in `view-router.tsx` and the shadow-the-globals seam here. Without
 * this subscription, pressing Esc / `s` / `d` / `!` / `x` while the help
 * overlay is open would fire BOTH handlers — the overlay would close AND
 * the global handler would silently navigate to the corresponding view.
 */
function useHelpOpen(): boolean {
  const [open, setOpen] = useState<boolean>(() => helpToggleBus.isOpen());
  useEffect(() => {
    return helpToggleBus.subscribe(() => {
      setOpen(helpToggleBus.isOpen());
    });
  }, []);
  return open;
}

export function useGlobalKeys(): void {
  const router = useRouterOptional();
  const app = useApp();
  const currentPrompt = useCurrentPrompt();
  const activeNotification = useActiveNotification();
  const helpOpen = useHelpOpen();
  // Disable the handler outright when the router is not mounted (view unit
  // tests render individual views without a `<ViewRouter />`), while a prompt
  // owns the keyboard, or while the help overlay is showing (it owns its own
  // keys; suppressing the global handler avoids double-fire on `?` / Esc and
  // prevents stray `s`/`d`/`!`/`x` presses from silently navigating the
  // underlying view while help is on screen).
  const routerHotkeysActive = router !== null && currentPrompt === null && !helpOpen;

  useInput(
    (input, key) => {
      if (router === null) return;
      // A live notification owns Esc and its action key — let the
      // StickyNotification component handle them so the global handler
      // doesn't double-fire (e.g. push the runs list AND have the
      // notification's onDismiss separately succeed).
      if (activeNotification !== null) {
        if (key.escape) return;
        if (activeNotification.action?.key === input) return;
      }
      if (key.escape) {
        // Canonical 'global.back' = 'esc'. The Ink `key.escape` flag is the
        // authoritative test; the map's stringly-typed 'esc' is documentation.
        router.pop();
        return;
      }
      if (input === getKeyFor('global.home')) {
        // Drop Home's remembered submenu so the fresh mount shows the main
        // pipeline map instead of restoring the last submenu the user was in.
        // "Go home" means the landing screen, not the last submenu — Esc is
        // the right key for "back to where I came from".
        clearHomeSubmenuMemory();
        router.reset({ id: 'home' });
        return;
      }
      const currentViewId: ViewId = router.current.id;
      if (input === getKeyFor('global.settings') && currentViewId !== 'settings') {
        router.push({ id: 'settings' });
        return;
      }
      if (input === getKeyFor('global.dashboard') && currentViewId !== 'dashboard') {
        router.push({ id: 'dashboard' });
        return;
      }
      if (input === getKeyFor('global.runs') && currentViewId !== 'running-executions') {
        router.push({ id: 'running-executions' });
        return;
      }
      if (input === getKeyFor('global.doctor') && currentViewId !== 'doctor') {
        router.push({ id: 'doctor' });
        return;
      }
      if (input === getKeyFor('global.help')) {
        // The help overlay is mounted by `ViewRouter` and toggled via a
        // sibling state. Setting the toggle goes through the bus shared with
        // the overlay component — see `view-router.tsx`.
        helpToggleBus.toggle();
        return;
      }
      if (input === getKeyFor('global.quit') && router.stack.length === 1 && currentViewId === 'home') {
        app.exit();
      }
    },
    { isActive: routerHotkeysActive }
  );
}

/** Test-only: confirm a binding lookup. Exported for keyboard-map.test.ts. */
export function bindingKeyForGlobal(action: Extract<Action, `global.${string}`>): string {
  return getKeyFor(action);
}
