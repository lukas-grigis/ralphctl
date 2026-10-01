/**
 * Global keyboard handler. Mounted once at the app root; suspended whenever a prompt is in
 * flight or the help overlay is open so the underlying view's local handler doesn't fight the
 * modal. Quitting (`q` / Ctrl-C) is allowed to win unconditionally — it's the operator's escape
 * hatch.
 */

import { useApp, useInput, type Key } from 'ink';
import { useRouter, type RouterApi, type ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { SECTIONS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useClaimedKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useSessionManager } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import type { SessionRecord } from '@src/application/ui/tui/runtime/session-manager.ts';

type UiStateApi = ReturnType<typeof useUiState>;
type SelectionApi = ReturnType<typeof useSelection>;

export interface UseGlobalKeysOptions {
  /** Disable everything except the quit chord. Useful while a prompt is mounted. */
  readonly disabled?: boolean;
}

export const useGlobalKeys = (opts: UseGlobalKeysOptions = {}): void => {
  const { exit } = useApp();
  const router = useRouter();
  const ui = useUiState();
  const selection = useSelection();
  const sessions = useSessionManager();
  const { isClaimed } = useClaimedKeys();

  useInput((input, key) => {
    if (handleQuitChord(input, key, router, opts.disabled, exit)) return;
    if (opts.disabled) return;
    if (handleHelpOverlay(ui, input, key)) return;
    if (handleSwitcherOverlay(ui)) return;
    if (handleProgressOverlay(ui, selection, input, key, isClaimed)) return;
    if (handleEvaluationOverlay(ui, input, key)) return;
    if (handleSessionNav(sessions, router, input, key)) return;

    if (key.escape && !ui.escapeClaimed) {
      router.pop();
      return;
    }

    // Ambient single-character chords: a key the active view (or an open overlay) claims is theirs.
    if (isClaimed(input)) return;
    if (handleSectionDigit(input, key, router)) return;
    handleAccelerator(input, router, ui);
  });
};

/** The Work section's root — Home. The only place `q` quits. */
const isWorkRoot = (router: Pick<RouterApi, 'current' | 'activeSection' | 'stack'>): boolean =>
  router.activeSection === 'work' && router.stack.length <= 1 && router.current.id === 'home';

/** Quitting (`Ctrl-C` anywhere, or `q` on the Work root) is the operator's escape hatch — it always wins. */
const handleQuitChord = (
  input: string,
  key: Key,
  router: Pick<RouterApi, 'current' | 'activeSection' | 'stack'>,
  disabled: boolean | undefined,
  exit: () => void
): boolean => {
  if ((key.ctrl && input === 'c') || (input === 'q' && isWorkRoot(router) && !disabled)) {
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
 * Context switcher — while it is open it owns the keyboard: its own `useInput` handles ↑/↓, ↵, `c`,
 * `t`, `f` and `esc` (closing the overlay). Here we only swallow, so no global chord (`g`, digits,
 * `esc` → pop) fires on the hidden view underneath. `?` and `ctrl+c` are handled before this.
 */
const handleSwitcherOverlay = (ui: UiStateApi): boolean => ui.switcherFocus !== undefined;

/**
 * Progress overlay — same modal contract as help. `g` opens (only when a sprint is loaded);
 * `g` also dismisses while open so the operator can mash the same key to toggle. `esc`
 * dismisses. The open-gate mirrors the overlay's own sprint resolution
 * (`focusedRunSprintId ?? selection.sprintId`): when an Execute view pins a run whose sprint
 * is not the global selection, `g` must still open onto the pinned run instead of silently
 * no-op'ing. Home — neither pinned nor selected — stays a no-op as the spec demands.
 */
const handleProgressOverlay = (
  ui: UiStateApi,
  selection: SelectionApi,
  input: string,
  key: Key,
  isClaimed: (key: string) => boolean
): boolean => {
  if (ui.progressOpen) {
    if (key.escape || input === 'g') ui.toggleProgress();
    return true;
  }
  if (input === 'g' && !isClaimed(input) && (ui.focusedRunSprintId ?? selection.sprintId) !== undefined) {
    ui.toggleProgress();
    return true;
  }
  return false;
};

/**
 * Evaluation overlay — CLOSE-ONLY here. `esc` or `v` dismisses while open, and the swallow keeps
 * the keystroke off the hidden view underneath.
 *
 * Opening is deliberately NOT global: the overlay needs the focused task's recorded verdict, and
 * only the Execute Tasks panel / sprint-detail know which card the cursor is on. Home, Flows and
 * Settings have no such notion, so a global `v` would need an open-gate they cannot satisfy — and
 * `flows-view` already binds a view-local `v` of its own. Handling the CLOSE centrally (rather
 * than in each view) is what lets it win over those now-inert view handlers.
 */
const handleEvaluationOverlay = (ui: UiStateApi, input: string, key: Key): boolean => {
  if (ui.evaluationTarget === undefined) return false;
  if (key.escape || input === 'v') ui.closeEvaluation();
  return true;
};

/**
 * Multi-flow navigation. Tab / Shift+Tab cycle through the RUNNING sessions; Ctrl+1..9 jump
 * to the Nth running session (1-indexed). Reaches this point only when no prompt is mounted
 * (opts.disabled gate above) and no overlay is open (help / progress early-returned). Focusing
 * a session lands on the `execute` route keyed on the session id, in the Runs section. With zero running sessions every chord is a silent no-op.
 */
const handleSessionNav = (
  sessions: { list(): readonly SessionRecord[] },
  router: Pick<RouterApi, 'current' | 'reset' | 'replace'>,
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
 * Section digits `1`–`5`. Pressing the active section's digit resets it to its root (handled by
 * `goSection`). Inert in the first-run wizard, where there is no tab bar to jump through.
 */
const handleSectionDigit = (input: string, key: Key, router: RouterApi): boolean => {
  if (key.ctrl || key.meta || router.activeSection === 'none') return false;
  const section = SECTIONS.find((s) => s.digit === input);
  if (section === undefined) return false;
  router.goSection(section.id);
  return true;
};

/**
 * Hidden single-letter accelerators — `h n x s ! S P`. They are not advertised in the footer (the
 * tab bar teaches the five sections); each lands on an explicit destination through `reset`, which
 * is what keeps pressing one from a deep stack from ballooning history. Pressing the accelerator
 * for the view you are already on is a no-op.
 */
const handleAccelerator = (input: string, router: RouterApi, ui: UiStateApi): boolean => {
  const land = (entry: ViewEntry): boolean => {
    const atRoot = router.stack.length <= 1;
    if (router.current.id === entry.id && (entry.id !== 'home' || atRoot)) return true;
    router.reset(entry);
    return true;
  };

  switch (input) {
    case 'h':
      // Explicit destination — `reset` never infers one. On a first-run session the launch
      // entry is the welcome wizard, and inferring it here sent `h` backwards into first-run
      // setup instead of Work.
      return land({ id: 'home' });
    case 'n':
      return land({ id: 'flows' });
    case 'x':
      return land({ id: 'sessions' });
    case 's':
      return land({ id: 'settings' });
    case '!':
      return land({ id: 'doctor' });
    case 'S':
      ui.openSwitcher('sprint');
      return true;
    case 'P':
      ui.openSwitcher('project');
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
 * On the Execute view we `replace` (don't stack history while hopping between live runs); from any
 * other view we `reset` onto the Runs section (`[Runs, Execute]`), so `esc` climbs Runs → Work.
 */
const focusRunningSession = (
  sessions: { list(): readonly SessionRecord[] },
  router: Pick<RouterApi, 'current' | 'reset' | 'replace'>,
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
  else router.reset(entry);
};
