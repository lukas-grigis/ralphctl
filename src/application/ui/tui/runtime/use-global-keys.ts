/**
 * Global keyboard handler. Mounted once at the app root; suspended whenever a prompt is in
 * flight or the help overlay is open so the underlying view's local handler doesn't fight the
 * modal. Quitting (`q` / Ctrl-C) is allowed to win unconditionally — it's the operator's escape
 * hatch.
 */

import { useApp, useInput } from 'ink';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';

export interface UseGlobalKeysOptions {
  /** Disable everything except the quit chord. Useful while a prompt is mounted. */
  readonly disabled?: boolean;
}

export const useGlobalKeys = (opts: UseGlobalKeysOptions = {}): void => {
  const { exit } = useApp();
  const router = useRouter();
  const ui = useUiState();

  useInput((input, key) => {
    // Quit always wins.
    if ((key.ctrl && input === 'c') || (input === 'q' && router.current.id === 'home' && !opts.disabled)) {
      exit();
      return;
    }

    if (opts.disabled) return;

    // Help toggle is recognised even when the overlay is open — pressing `?` dismisses it.
    if (input === '?') {
      ui.toggleHelp();
      return;
    }
    // Help mode swallows the rest of the keystrokes; only Esc dismisses.
    if (ui.helpOpen) {
      if (key.escape) ui.toggleHelp();
      return;
    }

    if (key.escape) {
      router.pop();
      return;
    }

    // Pressing the shortcut for the view you're already on is a no-op — otherwise the breadcrumb
    // stack would balloon as the user mashes the same key.
    const navigate = (id: string): void => {
      if (router.current.id === id) return;
      router.push({ id });
    };

    switch (input) {
      case 'h':
        if (router.current.id !== 'home') router.reset();
        return;
      case 'n':
        navigate('flows');
        return;
      case 'x':
        navigate('sessions');
        return;
      case 's':
        navigate('settings');
        return;
      case '!':
        navigate('doctor');
        return;
      case 'P':
        // Capital P opens the project picker from anywhere — lowercase `p` still routes to
        // the read-only Projects view. The picker remembers the current selection as its
        // default cursor so Enter is a one-keystroke confirm.
        navigate('pick-project');
        return;
      case 'S':
        // Mirror of `P` for sprints: capital S opens the sprint picker from anywhere;
        // lowercase `s` still routes to Settings. Picker is project-scoped, so it relies
        // on a project being loaded; otherwise it shows a "no project loaded" card.
        navigate('pick-sprint');
    }
  });
};
