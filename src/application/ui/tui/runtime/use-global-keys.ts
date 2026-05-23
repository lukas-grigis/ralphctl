/**
 * Global keyboard handler. Mounted once at the app root; suspended whenever a prompt is in
 * flight or the help overlay is open so the underlying view's local handler doesn't fight the
 * modal. Quitting (`q` / Ctrl-C) is allowed to win unconditionally — it's the operator's escape
 * hatch.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useApp, useInput } from 'ink';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { createCopyToClipboard, type CopyToClipboard } from '@src/integration/io/clipboard.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { MutableRefObject } from 'react';

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
