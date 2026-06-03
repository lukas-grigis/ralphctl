/**
 * Global keyboard handler. Mounted once at the app root; suspended whenever a prompt is in
 * flight or the help overlay is open so the underlying view's local handler doesn't fight the
 * modal. Quitting (`q` / Ctrl-C) is allowed to win unconditionally — it's the operator's escape
 * hatch.
 */

import type { MutableRefObject } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { useApp, useInput } from 'ink';
import { useRouter, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { type CopyToClipboard, createCopyToClipboard } from '@src/integration/io/clipboard.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/** Duration of the "Copied to clipboard" toast before the global handler auto-clears it. */
const CLIPBOARD_TOAST_DURATION_MS = 2000;
const CLIPBOARD_BANNER_ID = 'clipboard-copy';

export interface UseGlobalKeysOptions {
  /** Disable everything except the quit chord. Useful while a prompt is mounted. */
  readonly disabled?: boolean;
  /**
   * Override the clipboard adapter for tests. Production callers leave this undefined — the
   * platform-detecting default reads `process.platform` + `process.env` at module load.
   */
  readonly copyToClipboard?: CopyToClipboard;
}

export const useGlobalKeys = (opts: UseGlobalKeysOptions = {}): void => {
  const { exit } = useApp();
  const router = useRouter();
  const ui = useUiState();
  const selection = useSelection();
  const deps = useDeps();
  const sessions = useSessionManager();
  const copyToClipboard = useMemo<CopyToClipboard>(
    () => opts.copyToClipboard ?? createCopyToClipboard(),
    [opts.copyToClipboard]
  );
  // Track the pending toast-clear timeout so an in-flight copy doesn't double-emit a clear once
  // a second copy resets the banner. The latest copy wins — the prior timeout is cancelled.
  const clearTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(
    () => () => {
      if (clearTimerRef.current !== undefined) clearTimeout(clearTimerRef.current);
    },
    []
  );

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

    // Progress overlay — same modal contract as help. `g` opens (only when a sprint is loaded);
    // `g` also dismisses while open so the operator can mash the same key to toggle. `esc`
    // dismisses. Anchoring on `selection.sprintId` keeps Home a no-op as the spec demands.
    if (ui.progressOpen) {
      if (key.escape || input === 'g') ui.toggleProgress();
      return;
    }
    if (input === 'g' && selection.sprintId !== undefined) {
      ui.toggleProgress();
      return;
    }

    // Multi-flow navigation. Tab / Shift+Tab cycle through the RUNNING sessions; Ctrl+1..9 jump
    // to the Nth running session (1-indexed). Reaches this point only when no prompt is mounted
    // (opts.disabled gate above) and no overlay is open (help / progress early-returned). Focusing
    // a session reuses the Sessions view's mechanism — push / replace the `execute` route keyed on
    // the session id. With zero running sessions every chord is a silent no-op.
    if (key.tab) {
      focusRunningSession(sessions, router, key.shift ? 'prev' : 'next');
      return;
    }
    if (key.ctrl && /^[1-9]$/.test(input)) {
      focusRunningSession(sessions, router, Number(input) - 1);
      return;
    }

    if (key.escape && !ui.escapeClaimed) {
      router.pop();
      return;
    }

    // `y` (yank) copies the currently-focused task's markdown summary. The execute view
    // registers an `ActiveTaskSummaryProvider` on UiState while it is mounted with bucketed
    // data; everywhere else the provider is undefined and the hotkey surfaces a "no active
    // task" toast instead of silently dropping the keystroke (silent fail = mystery for the
    // operator).
    if (input === 'y') {
      const summary = ui.getActiveTaskSummary();
      if (summary === undefined) {
        emitClipboardBanner(deps.eventBus, {
          tier: 'info',
          message: 'No active task to copy',
        });
        scheduleClear(deps.eventBus, clearTimerRef);
        return;
      }
      void (async (): Promise<void> => {
        const result = await copyToClipboard(summary);
        if (result.ok) {
          emitClipboardBanner(deps.eventBus, {
            tier: 'info',
            message: 'Copied to clipboard',
          });
        } else {
          emitClipboardBanner(deps.eventBus, {
            tier: 'warn',
            message: 'Clipboard copy failed',
            cause: result.error.message,
          });
        }
        scheduleClear(deps.eventBus, clearTimerRef);
      })();
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
      case 'b':
        // Banner full ↔ compact toggle. Overrides the view's `compactBanner` prop for the rest
        // of the session — pressing `h` back to Home does not reset the toggle.
        ui.toggleBanner();
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

/**
 * Navigate to a running session's Execute view, reusing the exact route the Sessions view's
 * open action pushes (`{ id: 'execute', props: { sessionId } }`).
 *
 * `target` is either an absolute 0-based index (Ctrl+1..9 jump) or a relative direction
 * (`'next'` / `'prev'` for Tab / Shift+Tab). Relative cycling wraps modularly off the currently
 * focused session's index; entering from a non-execute view starts at the first (`'next'`) or
 * last (`'prev'`) running session. An out-of-range jump index and an empty running list are both
 * silent no-ops.
 *
 * On the Execute view we `replace` (don't stack breadcrumb history while hopping between live
 * runs); from any other view we `push` so `esc` returns to where the operator came from.
 */
const focusRunningSession = (
  sessions: { list(): readonly SessionRecord[] },
  router: { current: ViewEntry; push(e: ViewEntry): void; replace(e: ViewEntry): void },
  target: number | 'next' | 'prev'
): void => {
  const running = sessions.list().filter((s) => s.descriptor.status === 'running');
  if (running.length === 0) return;

  const onExecute = router.current.id === 'execute';
  const focusedId = onExecute ? (router.current.props?.sessionId as string | undefined) : undefined;
  const focusedIndex = running.findIndex((s) => s.descriptor.id === focusedId);

  let next: number;
  if (typeof target === 'number') {
    if (target < 0 || target >= running.length) return;
    next = target;
  } else if (focusedIndex === -1) {
    // Entering from a non-execute view (or focused session no longer running): Tab → first,
    // Shift+Tab → last.
    next = target === 'next' ? 0 : running.length - 1;
  } else {
    const delta = target === 'next' ? 1 : -1;
    next = (focusedIndex + delta + running.length) % running.length;
  }

  const targetSession = running[next];
  if (targetSession === undefined) return;
  const entry: ViewEntry = { id: 'execute', props: { sessionId: targetSession.descriptor.id } };
  if (onExecute) router.replace(entry);
  else router.push(entry);
};

interface ClipboardBannerSpec {
  readonly tier: 'info' | 'warn';
  readonly message: string;
  readonly cause?: string;
}

/**
 * Publish a clipboard toast onto the event bus. Pinned to a stable `id` so re-presses replace
 * (rather than stack) the banner — pressing `y` four times shows four "Copied to clipboard"
 * toasts on top of one another otherwise.
 */
const emitClipboardBanner = (eventBus: EventBus, spec: ClipboardBannerSpec): void => {
  eventBus.publish({
    type: 'banner-show',
    id: CLIPBOARD_BANNER_ID,
    tier: spec.tier,
    message: spec.message,
    ...(spec.cause !== undefined ? { cause: spec.cause } : {}),
    at: IsoTimestamp.now(),
  });
};

/**
 * Schedule a `banner-clear` for the clipboard toast after {@link CLIPBOARD_TOAST_DURATION_MS}.
 * The ref tracks the pending timeout so consecutive copies overwrite the timer in place — the
 * latest copy always wins.
 */
const scheduleClear = (eventBus: EventBus, ref: MutableRefObject<NodeJS.Timeout | undefined>): void => {
  if (ref.current !== undefined) clearTimeout(ref.current);
  ref.current = setTimeout(() => {
    eventBus.publish({
      type: 'banner-clear',
      id: CLIPBOARD_BANNER_ID,
      at: IsoTimestamp.now(),
    });
    ref.current = undefined;
  }, CLIPBOARD_TOAST_DURATION_MS);
};
