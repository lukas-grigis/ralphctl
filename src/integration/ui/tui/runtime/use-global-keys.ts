/**
 * useGlobalKeys — centralises the router-level hotkeys (Esc, h, s, d, ?, q) so
 * every view inherits them regardless of its own `useInput` handlers.
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
 */

import { useApp, useInput } from 'ink';
import { useCurrentPrompt } from '@src/integration/ui/prompts/hooks.ts';
import { useRouterOptional } from '@src/integration/ui/tui/views/router-context.ts';
import { clearHomeSubmenuMemory } from '@src/integration/ui/tui/views/home-submenu-memory.ts';

export function useGlobalKeys(): void {
  const router = useRouterOptional();
  const app = useApp();
  const currentPrompt = useCurrentPrompt();
  // Disable the handler outright when the router is not mounted (view unit
  // tests render individual views without a `<ViewRouter />`) or while a
  // prompt owns the keyboard.
  const routerHotkeysActive = router !== null && currentPrompt === null;

  useInput(
    (input, key) => {
      if (router === null) return;
      if (key.escape) {
        router.pop();
        return;
      }
      if (input === 'h') {
        // Drop Home's remembered submenu so the fresh mount shows the main
        // pipeline map instead of restoring the last submenu the user was in.
        // "Go home" means the landing screen, not the last submenu — Esc is
        // the right key for "back to where I came from".
        clearHomeSubmenuMemory();
        router.reset({ id: 'home' });
        return;
      }
      if (input === 's' && router.current.id !== 'settings') {
        router.push({ id: 'settings' });
        return;
      }
      if (input === 'd' && router.current.id !== 'dashboard') {
        router.push({ id: 'dashboard' });
        return;
      }
      if (input === '?' && router.current.id !== 'doctor') {
        router.push({ id: 'doctor' });
        return;
      }
      if (input === 'q' && router.stack.length === 1 && router.current.id === 'home') {
        app.exit();
      }
    },
    { isActive: routerHotkeysActive }
  );
}
