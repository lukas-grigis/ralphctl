/**
 * UI-only state — pieces of state that aren't owned by any specific view but are read by many (help-overlay open,
 * prompt mounted, terminal columns).
 */

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';

/** Project/sprint context captured from the currently-focused Execute view. */
export interface FocusedRunCtx {
  readonly projectLabel: string | undefined;
  readonly sprintId: SprintId | undefined;
  readonly sprintLabel: string | undefined;
}

/**
 * Closure returned by the focused view that, on demand, renders the markdown summary of the task the operator is
 * currently watching.
 */
export type ActiveTaskSummaryProvider = () => string | undefined;

/** Where the context switcher lands its cursor: on the current sprint (`S`) or the current project's header (`P`). */
export type SwitcherFocus = 'sprint' | 'project';

/** The ONE modal-overlay slot. */
export type Overlay =
  | { readonly kind: 'help' }
  | { readonly kind: 'switcher'; readonly focus: SwitcherFocus }
  | { readonly kind: 'progress' }
  | { readonly kind: 'evaluation'; readonly target: EvaluationTarget };

interface OverlayApi {
  /** The open overlay, or `undefined`. `helpOpen` / `progressOpen` / `evaluationTarget` derive from it. */
  readonly overlay: Overlay | undefined;
  readonly helpOpen: boolean;
  /** The context switcher's focus while it is open, else `undefined`. */
  readonly switcherFocus: SwitcherFocus | undefined;
  /**
   * Open-state for the read-only `progress.md` overlay. Bound to the global `g` hotkey via {@link useGlobalKeys},
   * gated on a sprint being loaded in {@link useSelection}.
   */
  readonly progressOpen: boolean;
  /**
   * The attempt whose `evaluation.md` the read-only evaluation overlay is showing, or `undefined` when it is closed.
   */
  readonly evaluationTarget: EvaluationTarget | undefined;
  /** `true` whenever any caller currently holds a {@link claimPrompt} release token. */
  readonly promptActive: boolean;
  /**
   * Derived convenience flag — `true` whenever any modal overlay or prompt is open: `overlay !== undefined ||
   * promptActive`.
   */
  readonly modalOpen: boolean;
  /** `true` whenever any caller currently holds a {@link claimEscape} release token. */
  readonly escapeClaimed: boolean;
  /** User-toggle for the banner mode. */
  readonly bannerCompact: boolean;

  /** Open `next`, replacing whichever overlay is currently open. */
  openOverlay(next: Overlay): void;

  /** Close whichever overlay is open. */
  closeOverlay(): void;

  toggleHelp(): void;

  toggleProgress(): void;

  /** Open the context switcher (`S` / `P`), replacing whichever overlay is open. */
  openSwitcher(focus: SwitcherFocus): void;

  /** Open the evaluation overlay onto `target`. Re-opening with a new target swaps it in place. */
  openEvaluation(target: EvaluationTarget): void;

  /** Close the evaluation overlay only — a no-op while another overlay is open. */
  closeEvaluation(): void;

  toggleBanner(): void;

  /**
   * Claim "input is captured by a prompt; suspend global keys." Returns a release function matched 1:1 to the claim —
   * calling release more than once is a no-op.
   */
  claimPrompt(): () => void;

  /**
   * Claim the `esc` keystroke for a view-local handler; the global `router.pop()` stays out of the way until every
   * claim is released.
   */
  claimEscape(): () => void;
}

interface FocusedRunApi {
  /**
   * Pin the project/sprint context of the currently-focused Execute view. Breadcrumb and progress overlay prefer this
   * over the global selection while a value is set.
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
   * Register a provider for the markdown summary of the operator's currently-focused task — read by the global `y`
   * hotkey via {@link getActiveTaskSummary}.
   */
  setActiveTaskSummaryProvider(provider: ActiveTaskSummaryProvider | undefined): void;
  /** Invoke the currently-registered provider, or return `undefined` if none is. */
  getActiveTaskSummary(): string | undefined;
}

interface SessionScratchApi {
  /**
   * Session-scoped pin for the repository the user most recently picked inside one of the project-scoped flows
   * (detect-scripts / detect-skills / readiness).
   */
  readonly sessionRepositoryId: RepositoryId | undefined;

  setSessionRepositoryId(id: RepositoryId | undefined): void;
}

interface UiStateApi extends OverlayApi, FocusedRunApi, YankProviderApi, SessionScratchApi {}

const OverlayContext = createContext<OverlayApi | undefined>(undefined);

/**
 * A counter-based claim: each call to the returned `claim` bumps the count and hands back a release matched 1:1
 * (releasing twice is a no-op).
 */
const useClaimCounter = (): readonly [number, () => () => void] => {
  const [count, setCount] = useState(0);
  const claim = useCallback((): (() => void) => {
    setCount((c) => c + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setCount((c) => Math.max(0, c - 1));
    };
  }, []);
  return [count, claim];
};

const OverlayProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const [bannerCompact, setBannerCompact] = useState(false);
  const [claims, claimPrompt] = useClaimCounter();
  const [escapeClaims, claimEscape] = useClaimCounter();

  const openOverlay = useCallback((next: Overlay) => {
    setOverlay(next);
  }, []);

  const closeOverlay = useCallback(() => {
    setOverlay(undefined);
  }, []);

  const toggleHelp = useCallback(() => {
    setOverlay((cur) => (cur?.kind === 'help' ? undefined : { kind: 'help' }));
  }, []);

  const toggleProgress = useCallback(() => {
    setOverlay((cur) => (cur?.kind === 'progress' ? undefined : { kind: 'progress' }));
  }, []);

  const openSwitcher = useCallback((focus: SwitcherFocus) => {
    setOverlay({ kind: 'switcher', focus });
  }, []);

  const openEvaluation = useCallback((target: EvaluationTarget) => {
    setOverlay({ kind: 'evaluation', target });
  }, []);

  const closeEvaluation = useCallback(() => {
    setOverlay((cur) => (cur?.kind === 'evaluation' ? undefined : cur));
  }, []);

  const toggleBanner = useCallback(() => {
    setBannerCompact((v) => !v);
  }, []);

  const api = useMemo<OverlayApi>(
    () => ({
      overlay,
      helpOpen: overlay?.kind === 'help',
      switcherFocus: overlay?.kind === 'switcher' ? overlay.focus : undefined,
      progressOpen: overlay?.kind === 'progress',
      evaluationTarget: overlay?.kind === 'evaluation' ? overlay.target : undefined,
      promptActive: claims > 0,
      modalOpen: overlay !== undefined || claims > 0,
      escapeClaimed: escapeClaims > 0,
      bannerCompact,
      openOverlay,
      closeOverlay,
      toggleHelp,
      toggleProgress,
      openSwitcher,
      openEvaluation,
      closeEvaluation,
      toggleBanner,
      claimPrompt,
      claimEscape,
    }),
    [
      overlay,
      claims,
      escapeClaims,
      bannerCompact,
      openOverlay,
      closeOverlay,
      toggleHelp,
      toggleProgress,
      openSwitcher,
      openEvaluation,
      closeEvaluation,
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

/** Like {@link useOverlayState} but `undefined` outside a provider — for primitives used in isolated tests. */
export const useOptionalOverlayState = (): OverlayApi | undefined => useContext(OverlayContext);

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
  // The active-task summary provider is registered through a ref so swapping it does not churn the context value
  // (which would re-render every consumer including unrelated views).
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

/** `sessionRepositoryId` — launch state threaded into `launchFlow.extras.repositoryId`, not UI state. */
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
 * Thin alias over the four contexts above, kept ONLY so existing call sites that destructure a single merged `ui`
 * object keep compiling unchanged.
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
