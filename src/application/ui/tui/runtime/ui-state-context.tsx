/**
 * UI-only state — pieces of state that aren't owned by any specific view but are read by many
 * (help-overlay open, prompt mounted, terminal columns).
 *
 * Keeping this isolated means the global key handler, ViewShell, and PromptHost can coordinate
 * (e.g. "while a prompt is mounted, ignore global keys") without cross-imports between views.
 *
 * The "prompt active" gate is a counter-based claim, not a boolean toggle: multiple sources
 * (the PromptHost for queued prompts, view-level inline prompts, transient editors) can each
 * hold a claim, and the global handler stays muted while at least one is live. Earlier we had
 * a single boolean which raced when two callers fought to set it true vs. false on the same
 * commit — the typed-character "n" leaking through to the flows hotkey is exactly that race.
 *
 * `claimEscape` is the same shape but narrower — only the `esc` key is muted, not the entire
 * global handler. A view (e.g. sprint detail's detail card) flips it on while it wants to own
 * `esc` for a local close action; the global `router.pop()` stands down for the duration.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

/**
 * Closure returned by the focused view that, on demand, renders the markdown summary of the
 * task the operator is currently watching. `undefined` means "no active task right now" (e.g.
 * the focused view doesn't know about tasks, or the run hasn't reached its first task yet).
 * The execute view registers one of these via {@link UiStateApi.setActiveTaskSummaryProvider}
 * whenever its `bucketed` data changes; the global `y` hotkey calls it.
 */
export type ActiveTaskSummaryProvider = () => string | undefined;

interface UiStateApi {
  readonly helpOpen: boolean;
  /**
   * Open-state for the read-only `progress.md` overlay. Bound to the global `g` hotkey via
   * {@link useGlobalKeys}, gated on a sprint being loaded in {@link useSelection}. Mounted
   * once at the {@link App} Layout level so every view inherits it without per-view wiring.
   */
  readonly progressOpen: boolean;
  /** `true` whenever any caller currently holds a {@link claimPrompt} release token. */
  readonly promptActive: boolean;
  /** `true` whenever any caller currently holds a {@link claimEscape} release token. */
  readonly escapeClaimed: boolean;
  /**
   * User-toggle override for the banner mode. `false` (default) defers to the view's
   * `compactBanner` prop; `true` forces the compact strip everywhere until the user toggles
   * it back. Bound to the global `b` hotkey via {@link useGlobalKeys}; persists for the
   * session (does not reset on navigation).
   */
  readonly bannerCompact: boolean;
  toggleHelp(): void;
  toggleProgress(): void;
  toggleBanner(): void;
  /**
   * Claim "input is captured by a prompt; suspend global keys." Returns a release function
   * matched 1:1 to the claim — calling release more than once is a no-op. The natural way to
   * use it is from a `useEffect`:
   *
   * ```tsx
   * useEffect(() => ui.claimPrompt(), [ui.claimPrompt]);
   * ```
   *
   * For a conditional claim, return the release fn (or undefined) from the effect so React's
   * cleanup handles the release:
   *
   * ```tsx
   * useEffect(() => editing ? ui.claimPrompt() : undefined, [editing, ui.claimPrompt]);
   * ```
   */
  claimPrompt(): () => void;
  /**
   * Claim the `esc` keystroke for a view-local handler; the global `router.pop()` stays out
   * of the way until every claim is released. Counter-based (same shape as {@link claimPrompt})
   * so multiple overlapping claims are safe. Use this when a view wants `esc` to close an
   * inline panel rather than navigate up the breadcrumb stack — every other global hotkey
   * (`?`, `b`, `g`, `y`, navigation) keeps working.
   *
   * ```tsx
   * useEffect(() => inDetail ? ui.claimEscape() : undefined, [inDetail, ui.claimEscape]);
   * ```
   */
  claimEscape(): () => void;
  /**
   * Session-scoped pin for the repository the user most recently picked inside one of the
   * project-scoped flows (detect-scripts / detect-skills / readiness). Cleared when the TUI
   * exits; not persisted to disk. Threaded via `launchFlow.extras.repositoryId` so subsequent
   * flows skip the repo prompt for the rest of the session.
   */
  readonly sessionRepositoryId: RepositoryId | undefined;
  setSessionRepositoryId(id: RepositoryId | undefined): void;
  /**
   * Register a provider for the markdown summary of the operator's currently-focused task —
   * read by the global `y` hotkey via {@link getActiveTaskSummary}. Stored in a ref (not
   * state), so registering / unregistering does not trigger a re-render on every render of the
   * execute view. The execute view calls this from a `useEffect`, returning `() =>
   * setActiveTaskSummaryProvider(undefined)` as the cleanup.
   *
   * Pass `undefined` to clear. The provider is itself synchronous so the hotkey can copy +
   * surface its toast in one tick.
   */
  setActiveTaskSummaryProvider(provider: ActiveTaskSummaryProvider | undefined): void;
  /**
   * Invoke the currently-registered provider, or return `undefined` if none is. Read by the
   * global `y` hotkey only — view code that owns the task data renders its own markdown.
   */
  getActiveTaskSummary(): string | undefined;
}

const UiStateContext = createContext<UiStateApi | undefined>(undefined);

export const UiStateProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [bannerCompact, setBannerCompact] = useState(false);
  const [claims, setClaims] = useState(0);
  const [escapeClaims, setEscapeClaims] = useState(0);
  const [sessionRepositoryId, setSessionRepositoryIdState] = useState<RepositoryId | undefined>(undefined);

  const toggleHelp = useCallback(() => {
    setHelpOpen((v) => !v);
  }, []);

  const toggleProgress = useCallback(() => {
    setProgressOpen((v) => !v);
  }, []);

  const toggleBanner = useCallback(() => {
    setBannerCompact((v) => !v);
  }, []);

  const claimPrompt = useCallback((): (() => void) => {
    setClaims((c) => c + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setClaims((c) => Math.max(0, c - 1));
    };
  }, []);

  const claimEscape = useCallback((): (() => void) => {
    setEscapeClaims((c) => c + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setEscapeClaims((c) => Math.max(0, c - 1));
    };
  }, []);

  const setSessionRepositoryId = useCallback((id: RepositoryId | undefined) => {
    setSessionRepositoryIdState(id);
  }, []);

  // The active-task summary provider is registered through a ref so swapping it does not churn
  // the context value (which would re-render every consumer including unrelated views). The
  // hotkey reads through `getActiveTaskSummary()` on press; until then the ref is dormant.
  const activeTaskSummaryProviderRef = useRef<ActiveTaskSummaryProvider | undefined>(undefined);
  const setActiveTaskSummaryProvider = useCallback((provider: ActiveTaskSummaryProvider | undefined): void => {
    activeTaskSummaryProviderRef.current = provider;
  }, []);
  const getActiveTaskSummary = useCallback((): string | undefined => {
    const provider = activeTaskSummaryProviderRef.current;
    if (provider === undefined) return undefined;
    try {
      return provider();
    } catch {
      // Provider must never throw. If it does (programmer error), treat as "no summary
      // available" so the hotkey surfaces a friendly toast instead of crashing the TUI.
      return undefined;
    }
  }, []);

  const api = useMemo<UiStateApi>(
    () => ({
      helpOpen,
      progressOpen,
      promptActive: claims > 0,
      escapeClaimed: escapeClaims > 0,
      bannerCompact,
      toggleHelp,
      toggleProgress,
      toggleBanner,
      claimPrompt,
      claimEscape,
      sessionRepositoryId,
      setSessionRepositoryId,
      setActiveTaskSummaryProvider,
      getActiveTaskSummary,
    }),
    [
      helpOpen,
      progressOpen,
      claims,
      escapeClaims,
      bannerCompact,
      toggleHelp,
      toggleProgress,
      toggleBanner,
      claimPrompt,
      claimEscape,
      sessionRepositoryId,
      setSessionRepositoryId,
      setActiveTaskSummaryProvider,
      getActiveTaskSummary,
    ]
  );

  return <UiStateContext.Provider value={api}>{children}</UiStateContext.Provider>;
};

export const useUiState = (): UiStateApi => {
  const ctx = useContext(UiStateContext);
  if (!ctx) throw new Error('useUiState: must be used inside <UiStateProvider>');
  return ctx;
};
