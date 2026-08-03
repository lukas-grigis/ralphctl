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
 *
 * This module actually hosts FOUR independent contexts, each with its own state and its own
 * memo, composed together inside one {@link UiStateProvider} so `App.tsx` still only ever
 * mounts a single provider:
 *
 *   - {@link useOverlayState} — the 30-consumer hot path (help/progress/prompt/modal/escape,
 *     the banner toggle).
 *   - {@link useFocusedRun} — the focused-run pinning quartet, written once per Execute-view
 *     mount/unmount and read by the breadcrumb + progress overlay.
 *   - {@link useYankProvider} — the active-task-summary ref registry read by the global `y`
 *     hotkey.
 *   - {@link useSessionScratch} — `sessionRepositoryId`, which is launch state threaded into
 *     `launchFlow.extras.repositoryId` (not UI state at all) but has no other session-scoped
 *     home yet; kept behind its own context/memo here rather than folded into the overlay
 *     concern so a repo pin doesn't re-render every overlay consumer.
 *
 * {@link useUiState} is a thin alias over all four, kept ONLY so the existing call sites (which
 * read a single merged `ui` object) keep compiling unchanged. New code should reach for the
 * narrowest hook that covers what it needs instead of `useUiState`.
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

/**
 * Project/sprint context captured from the currently-focused Execute view. Set on mount and
 * cleared on unmount so the breadcrumb and progress overlay reflect the run's own sprint rather
 * than the mutable global selection while the user is watching a run.
 */
export interface FocusedRunCtx {
  readonly projectLabel: string | undefined;
  readonly sprintId: SprintId | undefined;
  readonly sprintLabel: string | undefined;
}

/**
 * Closure returned by the focused view that, on demand, renders the markdown summary of the
 * task the operator is currently watching. `undefined` means "no active task right now" (e.g.
 * the focused view doesn't know about tasks, or the run hasn't reached its first task yet).
 * The execute view registers one of these via {@link UiStateApi.setActiveTaskSummaryProvider}
 * whenever its `bucketed` data changes; the global `y` hotkey calls it.
 */
export type ActiveTaskSummaryProvider = () => string | undefined;

interface OverlayApi {
  readonly helpOpen: boolean;
  /**
   * Open-state for the read-only `progress.md` overlay. Bound to the global `g` hotkey via
   * {@link useGlobalKeys}, gated on a sprint being loaded in {@link useSelection}. Mounted
   * once at the {@link App} Layout level so every view inherits it without per-view wiring.
   */
  readonly progressOpen: boolean;
  /** `true` whenever any caller currently holds a {@link claimPrompt} release token. */
  readonly promptActive: boolean;
  /**
   * Derived convenience flag — `true` whenever any modal overlay or prompt is open:
   * `progressOpen || helpOpen || promptActive`. Views and components use this single flag
   * in `useInput` early-returns and `listActive` expressions so hidden-but-mounted views
   * are fully inert while an overlay is shown.
   */
  readonly modalOpen: boolean;
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
}

interface FocusedRunApi {
  /**
   * Pin the project/sprint context of the currently-focused Execute view. Breadcrumb and
   * progress overlay prefer this over the global selection while a value is set. Cleared to
   * `undefined` when the Execute view unmounts.
   */
  setFocusedRunContext(ctx: FocusedRunCtx | undefined): void;
  /** Project label from the focused Execute view's pinned descriptor, or `undefined`. */
  readonly focusedRunProjectLabel: string | undefined;
  /** Sprint id from the focused Execute view's pinned descriptor, or `undefined`. */
  readonly focusedRunSprintId: SprintId | undefined;
  /** Sprint label from the focused Execute view's pinned descriptor, or `undefined`. */
  readonly focusedRunSprintLabel: string | undefined;
}

interface YankProviderApi {
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

interface SessionScratchApi {
  /**
   * Session-scoped pin for the repository the user most recently picked inside one of the
   * project-scoped flows (detect-scripts / detect-skills / readiness). Cleared when the TUI
   * exits; not persisted to disk. Threaded via `launchFlow.extras.repositoryId` so subsequent
   * flows skip the repo prompt for the rest of the session.
   */
  readonly sessionRepositoryId: RepositoryId | undefined;

  setSessionRepositoryId(id: RepositoryId | undefined): void;
}

interface UiStateApi extends OverlayApi, FocusedRunApi, YankProviderApi, SessionScratchApi {}

const OverlayContext = createContext<OverlayApi | undefined>(undefined);

const OverlayProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [bannerCompact, setBannerCompact] = useState(false);
  const [claims, setClaims] = useState(0);
  const [escapeClaims, setEscapeClaims] = useState(0);

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

  const api = useMemo<OverlayApi>(
    () => ({
      helpOpen,
      progressOpen,
      promptActive: claims > 0,
      modalOpen: progressOpen || helpOpen || claims > 0,
      escapeClaimed: escapeClaims > 0,
      bannerCompact,
      toggleHelp,
      toggleProgress,
      toggleBanner,
      claimPrompt,
      claimEscape,
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
    ]
  );

  return <OverlayContext.Provider value={api}>{children}</OverlayContext.Provider>;
};

/** The 30-consumer hot path: help/progress/prompt/modal/escape state + the banner toggle. */
export const useOverlayState = (): OverlayApi => {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error('useOverlayState: must be used inside <UiStateProvider>');
  return ctx;
};

const FocusedRunContext = createContext<FocusedRunApi | undefined>(undefined);

const FocusedRunProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [focusedRunCtx, setFocusedRunCtxState] = useState<FocusedRunCtx | undefined>(undefined);

  const setFocusedRunContext = useCallback((ctx: FocusedRunCtx | undefined): void => {
    setFocusedRunCtxState(ctx);
  }, []);

  const api = useMemo<FocusedRunApi>(
    () => ({
      setFocusedRunContext,
      focusedRunProjectLabel: focusedRunCtx?.projectLabel,
      focusedRunSprintId: focusedRunCtx?.sprintId,
      focusedRunSprintLabel: focusedRunCtx?.sprintLabel,
    }),
    [setFocusedRunContext, focusedRunCtx]
  );

  return <FocusedRunContext.Provider value={api}>{children}</FocusedRunContext.Provider>;
};

/** The focused-run pinning quartet, written once per Execute-view mount/unmount. */
export const useFocusedRun = (): FocusedRunApi => {
  const ctx = useContext(FocusedRunContext);
  if (!ctx) throw new Error('useFocusedRun: must be used inside <UiStateProvider>');
  return ctx;
};

const YankProviderContext = createContext<YankProviderApi | undefined>(undefined);

const YankProviderRegistryProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
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

  const api = useMemo<YankProviderApi>(
    () => ({ setActiveTaskSummaryProvider, getActiveTaskSummary }),
    [setActiveTaskSummaryProvider, getActiveTaskSummary]
  );

  return <YankProviderContext.Provider value={api}>{children}</YankProviderContext.Provider>;
};

/** The active-task-summary ref registry read by the global `y` hotkey. */
export const useYankProvider = (): YankProviderApi => {
  const ctx = useContext(YankProviderContext);
  if (!ctx) throw new Error('useYankProvider: must be used inside <UiStateProvider>');
  return ctx;
};

const SessionScratchContext = createContext<SessionScratchApi | undefined>(undefined);

const SessionScratchProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [sessionRepositoryId, setSessionRepositoryIdState] = useState<RepositoryId | undefined>(undefined);

  const setSessionRepositoryId = useCallback((id: RepositoryId | undefined) => {
    setSessionRepositoryIdState(id);
  }, []);

  const api = useMemo<SessionScratchApi>(
    () => ({ sessionRepositoryId, setSessionRepositoryId }),
    [sessionRepositoryId, setSessionRepositoryId]
  );

  return <SessionScratchContext.Provider value={api}>{children}</SessionScratchContext.Provider>;
};

/**
 * `sessionRepositoryId` — launch state threaded into `launchFlow.extras.repositoryId`, not UI
 * state. Kept behind its own context/memo so a repo pin doesn't re-render the overlay hot path.
 */
export const useSessionScratch = (): SessionScratchApi => {
  const ctx = useContext(SessionScratchContext);
  if (!ctx) throw new Error('useSessionScratch: must be used inside <UiStateProvider>');
  return ctx;
};

export const UiStateProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <OverlayProvider>
    <FocusedRunProvider>
      <YankProviderRegistryProvider>
        <SessionScratchProvider>{children}</SessionScratchProvider>
      </YankProviderRegistryProvider>
    </FocusedRunProvider>
  </OverlayProvider>
);

/**
 * Thin alias over the four contexts above, kept ONLY so existing call sites that destructure a
 * single merged `ui` object keep compiling unchanged. Do NOT migrate those call sites as part of
 * this change — reach for the narrower hook ({@link useOverlayState}, {@link useFocusedRun},
 * {@link useYankProvider}, {@link useSessionScratch}) in new code instead.
 */
export const useUiState = (): UiStateApi => {
  const overlay = useOverlayState();
  const focusedRun = useFocusedRun();
  const yank = useYankProvider();
  const sessionScratch = useSessionScratch();
  return useMemo<UiStateApi>(
    () => ({ ...overlay, ...focusedRun, ...yank, ...sessionScratch }),
    [overlay, focusedRun, yank, sessionScratch]
  );
};
