/**
 * Global keyboard handler. Mounted once at the app root; suspended whenever a prompt is in
 * flight or the help overlay is open so the underlying view's local handler doesn't fight the
 * modal. Quitting (`q` / Ctrl-C) is allowed to win unconditionally — it's the operator's escape
 * hatch.
 */

import type { MutableRefObject } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { useApp, useInput, type Key } from 'ink';
import { useRouter, type RouterApi, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useDeps } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';
import { type CopyToClipboard, createCopyToClipboard } from '@src/integration/io/clipboard.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

type UiStateApi = ReturnType<typeof useUiState>;
type SelectionApi = ReturnType<typeof useSelection>;

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
    if (handleQuitChord(input, key, router, opts.disabled, exit)) return;
    if (opts.disabled) return;
    if (handleHelpOverlay(ui, input, key)) return;
    if (handleProgressOverlay(ui, selection, input, key)) return;
    if (handleSessionNav(sessions, router, input, key)) return;

    if (key.escape && !ui.escapeClaimed) {
      router.pop();
      return;
    }

    if (handleYankCopy(ui, deps, copyToClipboard, clearTimerRef, input)) return;
    handleViewShortcut(input, router, ui);
  });
};

/** Quitting (`Ctrl-C` anywhere, or `q` on Home) is the operator's escape hatch — it always wins. */
const handleQuitChord = (
  input: string,
  key: Key,
  router: { current: ViewEntry },
  disabled: boolean | undefined,
  exit: () => void
): boolean => {
  if ((key.ctrl && input === 'c') || (input === 'q' && router.current.id === 'home' && !disabled)) {
    exit();
    return true;
  }
  return false;
};

/**
 * Help toggle is recognised even when the overlay is open — pressing `?` dismisses it. Once open,
 * help mode swallows the rest of the keystrokes; only Esc dismisses.
 */
const handleHelpOverlay = (ui: UiStateApi, input: string, key: Key): boolean => {
  if (input === '?') {
    ui.toggleHelp();
    return true;
  }
  if (ui.helpOpen) {
    if (key.escape) ui.toggleHelp();
    return true;
  }
  return false;
};

/**
 * Progress overlay — same modal contract as help. `g` opens (only when a sprint is loaded);
 * `g` also dismisses while open so the operator can mash the same key to toggle. `esc`
 * dismisses. The open-gate mirrors the overlay's own sprint resolution
 * (`focusedRunSprintId ?? selection.sprintId`): when an Execute view pins a run whose sprint
 * is not the global selection, `g` must still open onto the pinned run instead of silently
 * no-op'ing. Home — neither pinned nor selected — stays a no-op as the spec demands.
 */
const handleProgressOverlay = (ui: UiStateApi, selection: SelectionApi, input: string, key: Key): boolean => {
  if (ui.progressOpen) {
    if (key.escape || input === 'g') ui.toggleProgress();
    return true;
  }
  if (input === 'g' && (ui.focusedRunSprintId ?? selection.sprintId) !== undefined) {
    ui.toggleProgress();
    return true;
  }
  return false;
};

/**
 * Multi-flow navigation. Tab / Shift+Tab cycle through the RUNNING sessions; Ctrl+1..9 jump
 * to the Nth running session (1-indexed). Reaches this point only when no prompt is mounted
 * (opts.disabled gate above) and no overlay is open (help / progress early-returned). Focusing
 * a session reuses the Sessions view's mechanism — push / replace the `execute` route keyed on
 * the session id. With zero running sessions every chord is a silent no-op.
 */
const handleSessionNav = (
  sessions: { list(): readonly SessionRecord[] },
  router: { current: ViewEntry; push(e: ViewEntry): void; replace(e: ViewEntry): void },
  input: string,
  key: Key
): boolean => {
  if (key.tab) {
    focusRunningSession(sessions, router, key.shift ? 'prev' : 'next');
    return true;
  }
  if (key.ctrl && /^[1-9]$/.test(input)) {
    focusRunningSession(sessions, router, Number(input) - 1);
    return true;
  }
  return false;
};

/**
 * `y` (yank) copies the currently-focused task's markdown summary. The execute view
 * registers an `ActiveTaskSummaryProvider` on UiState while it is mounted with bucketed
 * data; everywhere else the provider is undefined and the hotkey surfaces a "no active
 * task" toast instead of silently dropping the keystroke (silent fail = mystery for the
 * operator).
 */
const handleYankCopy = (
  ui: UiStateApi,
  deps: { eventBus: EventBus },
  copyToClipboard: CopyToClipboard,
  clearTimerRef: MutableRefObject<NodeJS.Timeout | undefined>,
  input: string
): boolean => {
  if (input !== 'y') return false;

  const summary = ui.getActiveTaskSummary();
  if (summary === undefined) {
    emitClipboardBanner(deps.eventBus, {
      tier: 'info',
      message: 'No active task to copy',
    });
    scheduleClear(deps.eventBus, clearTimerRef);
    return true;
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
  return true;
};

/**
 * The trailing single-letter view shortcuts. Pressing the shortcut for the view you're already
 * on is a no-op — otherwise the breadcrumb stack would balloon as the user mashes the same key.
 */
const handleViewShortcut = (input: string, router: RouterApi, ui: UiStateApi): boolean => {
  const navigate = (id: string): void => {
    if (router.current.id === id) return;
    router.push({ id });
  };

  switch (input) {
    case 'h':
      if (router.current.id !== 'home') router.reset();
      return true;
    case 'n':
      navigate('flows');
      return true;
    case 'x':
      navigate('sessions');
      return true;
    case 's':
      navigate('settings');
      return true;
    case '!':
      navigate('doctor');
      return true;
    case 'b':
      // Banner full ↔ compact toggle. Overrides the view's `compactBanner` prop for the rest
      // of the session — pressing `h` back to Home does not reset the toggle.
      ui.toggleBanner();
      return true;
    case 'P':
      // Capital P opens the project picker from anywhere — lowercase `p` still routes to
      // the read-only Projects view. The picker remembers the current selection as its
      // default cursor so Enter is a one-keystroke confirm.
      navigate('pick-project');
      return true;
    case 'S':
      // Mirror of `P` for sprints: capital S opens the sprint picker from anywhere;
      // lowercase `s` still routes to Settings. Picker is project-scoped, so it relies
      // on a project being loaded; otherwise it shows a "no project loaded" card.
      navigate('pick-sprint');
      return true;
    default:
      return false;
  }
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
  // Guard: if the target is already the focused session, skip the router call — a replace with
  // an identical entry is a wasteful re-render when Tab cycles a single running session back to
  // itself (e.g. only one running session and Tab wraps modularly to the same id).
  if (targetSession.descriptor.id === focusedId) return;
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
