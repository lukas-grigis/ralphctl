/** Global keyboard handler. */

import { useApp, useInput, type Key } from 'ink';
import { countRunning } from '@src/application/ui/tui/runtime/quit-runs.ts';
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

  // Live runs get a confirm; with none, quitting is immediate.
  const quit = (): void => {
    const runs = countRunning(sessions.list());
    if (runs === 0) exit();
    else ui.openOverlay({ kind: 'quit', runs });
  };

  useInput((input, key) => {
    if (handleQuitChord(input, key, router, opts.disabled, quit, ui.overlay?.kind === 'quit')) return;
    if (opts.disabled) return;
    // The quit confirm owns every other key; its own handler answers it.
    if (ui.overlay?.kind === 'quit') return;
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

/**
 * Quitting (`Ctrl-C` anywhere, or `q` on the Work root) is the operator's escape hatch — it always wins. While the quit
 * confirm is open it handles both keys itself, so they are not re-read as a second request.
 */
const handleQuitChord = (
  input: string,
  key: Key,
  router: Pick<RouterApi, 'current' | 'activeSection' | 'stack'>,
  disabled: boolean | undefined,
  quit: () => void,
  confirmOpen: boolean
): boolean => {
  if (confirmOpen) return false;
  if ((key.ctrl && input === 'c') || (input === 'q' && isWorkRoot(router) && !disabled)) {
    quit();
    return true;
  }
  return false;
};

/**
 * Help toggle is recognised even when the overlay is open — pressing `?` dismisses it. Once open, help mode swallows
 * the rest of the keystrokes; only Esc dismisses.
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
 * Context switcher — while it is open it owns the keyboard: its own `useInput` handles ↑/↓, ↵, `c`, `t`, `f` and
 * `esc` (closing the overlay).
 */
const handleSwitcherOverlay = (ui: UiStateApi): boolean => ui.switcherFocus !== undefined;

/**
 * Progress overlay — same modal contract as help. `g` opens (only when a sprint is loaded); `g` also dismisses while
 * open so the operator can mash the same key to toggle.
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
 * Evaluation overlay — CLOSE-ONLY here. `esc` or `v` dismisses while open, and the swallow keeps the keystroke off
 * the hidden view underneath.
 */
const handleEvaluationOverlay = (ui: UiStateApi, input: string, key: Key): boolean => {
  if (ui.evaluationTarget === undefined) return false;
  if (key.escape || input === 'v') ui.closeEvaluation();
  return true;
};

/**
 * Multi-flow navigation. Tab / Shift+Tab cycle through the RUNNING sessions; Ctrl+1..9 jump to the Nth running
 * session (1-indexed).
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
 * Section digits `1`–`5`. Pressing the active section's digit resets it to its root (handled by `goSection`).
 */
const handleSectionDigit = (input: string, key: Key, router: RouterApi): boolean => {
  if (key.ctrl || key.meta || router.activeSection === 'none') return false;
  const section = SECTIONS.find((s) => s.digit === input);
  if (section === undefined) return false;
  router.goSection(section.id);
  return true;
};

/** Hidden single-letter accelerators — `h n x s ! S P`. */
const handleAccelerator = (input: string, router: RouterApi, ui: UiStateApi): boolean => {
  const land = (entry: ViewEntry): boolean => {
    const atRoot = router.stack.length <= 1;
    if (router.current.id === entry.id && (entry.id !== 'home' || atRoot)) return true;
    router.reset(entry);
    return true;
  };

  switch (input) {
    case 'h':
      // Explicit destination — `reset` never infers one.
      return land({ id: 'home' });
    case 'n':
      // Always re-enter: Work at its root still has to move its cursor onto the flow list.
      router.reset({ id: 'home', props: { focus: 'flows' } });
      return true;
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
 * Navigate to a running session's Execute view, reusing the exact route the Sessions view's open action pushes (`{
 * id: 'execute', props: { sessionId } }`).
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
    next = target === 'next' ? 0 : running.length - 1;
  } else {
    const delta = target === 'next' ? 1 : -1;
    next = (focusedIndex + delta + running.length) % running.length;
  }

  const targetSession = running[next];
  if (targetSession === undefined) return;
  // Guard: if the target is already the focused session, skip the router call.
  if (targetSession.descriptor.id === focusedId) return;
  const entry: ViewEntry = { id: 'execute', props: { sessionId: targetSession.descriptor.id } };
  if (onExecute) router.replace(entry);
  else router.reset(entry);
};
