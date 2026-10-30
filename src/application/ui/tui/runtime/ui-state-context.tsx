/**
 * UI-only state read by many views but owned by none (help-overlay open, prompt mounted, …), so
 * the global key handler, ViewShell and PromptHost coordinate without cross-imports.
 *
 * "Prompt active" is a counter of claims, not a boolean: several sources (PromptHost, inline
 * prompts, transient editors) can each hold one and global keys stay muted while any is live. A
 * single boolean raced when two callers set it on the same commit — a typed "n" leaked to the flows
 * hotkey. `claimEscape` is the narrower sibling that mutes only `esc` (the global `router.pop()`).
 *
 * Four independent contexts, each with its own state and memo, composed in one {@link UiStateProvider}.
 * Read the narrowest hook so unrelated changes (a repo pin, the focused run) don't re-render
 * overlay consumers:
 *   - {@link useOverlayState} — help/progress/evaluation/quit/prompt/modal/escape state + banner toggle
 *   - {@link useFocusedRun} — focused-run pinning, read by the breadcrumb + progress overlay
 *   - {@link useYankProvider} — active-task-summary registry read by the global `y` hotkey
 *   - {@link useSessionScratch} — `sessionRepositoryId`: launch state threaded into
 *     `launchFlow.extras.repositoryId`, with no better session-scoped home yet
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { EvaluationTarget } from '@src/application/ui/tui/runtime/evaluation-target.ts';

/**
 * Project/sprint context of the focused Execute view, set on mount and cleared on unmount so the
 * breadcrumb and progress overlay show the run's own sprint rather than the mutable global selection.
 */
export interface FocusedRunCtx {
  readonly projectLabel: string | undefined;
  readonly sprintId: SprintId | undefined;
  readonly sprintLabel: string | undefined;
}

/** Renders the markdown summary of the task the operator is watching; `undefined` = no active task. */
export type ActiveTaskSummaryProvider = () => string | undefined;

export interface OverlayApi {
  readonly helpOpen: boolean;
  /** Read-only `progress.md` overlay (global `g`, gated on a loaded sprint). */
  readonly progressOpen: boolean;
  /**
   * The attempt whose `evaluation.md` the overlay shows, or `undefined` when closed. Opened
   * view-locally from a focused card (`v`), which hands over the target; closed globally in
   * {@link useGlobalKeys} so `esc` / `v` win over the now-inert views underneath.
   */
  readonly evaluationTarget: EvaluationTarget | undefined;
  /** Some caller holds a {@link claimPrompt} token. */
  readonly promptActive: boolean;
  /** Any overlay or prompt is open — views use it in `useInput` early-returns so hidden views stay inert. */
  readonly modalOpen: boolean;
  /** Live runs the open quit confirm would stop; `undefined` while it is closed. */
  readonly quitRuns: number | undefined;
  /** Any overlay is open — it outranks a hidden prompt for the keyboard. */
  readonly overlayOpen: boolean;
  /** Some caller holds a {@link claimEscape} token. */
  readonly escapeClaimed: boolean;
  /** User override (global `b`): forces the compact banner everywhere for the session; `false` defers to the view. */
  readonly bannerCompact: boolean;

  toggleHelp(): void;
  toggleProgress(): void;
  /** Open the evaluation overlay onto `target`; re-opening swaps it in place. */
  openEvaluation(target: EvaluationTarget): void;
  closeEvaluation(): void;
  toggleBanner(): void;
  openQuit(runs: number): void;
  closeQuit(): void;

  /**
   * Claim "input is captured by a prompt; suspend global keys." Returns a release function
   * matched 1:1 to the claim (extra calls are no-ops):
   *
   * ```tsx
   * useEffect(() => ui.claimPrompt(), [ui.claimPrompt]);
   * useEffect(() => editing ? ui.claimPrompt() : undefined, [editing, ui.claimPrompt]);
   * ```
   */
  claimPrompt(): () => void;

  /**
   * Claim `esc` for a view-local close action; the global `router.pop()` stands down until every
   * claim is released. Every other global hotkey keeps working. Same shape as {@link claimPrompt}.
   */
  claimEscape(): () => void;
}

export interface FocusedRunApi {
  /** Pin the focused Execute view's context (preferred over the global selection); `undefined` on unmount. */
  setFocusedRunContext(ctx: FocusedRunCtx | undefined): void;
  readonly focusedRunProjectLabel: string | undefined;
  readonly focusedRunSprintId: SprintId | undefined;
  readonly focusedRunSprintLabel: string | undefined;
}

export interface YankProviderApi {
  /**
   * Register the focused task's summary provider (`undefined` clears). Stored outside React state,
   * so (un)registering never re-renders the execute view; the provider is synchronous so the `y`
   * hotkey can copy and toast in one tick.
   */
  setActiveTaskSummaryProvider(provider: ActiveTaskSummaryProvider | undefined): void;
  /** Invoke the registered provider; `undefined` if none (or it threw — the hotkey then toasts instead of crashing). */
  getActiveTaskSummary(): string | undefined;
}

export interface SessionScratchApi {
  /**
   * Repository most recently picked inside a project-scoped flow (detect-scripts / detect-skills /
   * readiness); later flows skip the repo prompt for the rest of the session. Not persisted.
   */
  readonly sessionRepositoryId: RepositoryId | undefined;
  setSessionRepositoryId(id: RepositoryId | undefined): void;
}

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

const OverlayContext = createContext<OverlayApi | undefined>(undefined);

const OverlayProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [evaluationTarget, setEvaluationTarget] = useState<EvaluationTarget | undefined>(undefined);
  const [bannerCompact, setBannerCompact] = useState(false);
  const [quitRuns, setQuitRuns] = useState<number | undefined>(undefined);
  const [claims, claimPrompt] = useClaimCounter();
  const [escapeClaims, claimEscape] = useClaimCounter();

  const actions = useMemo(
    () => ({
      toggleHelp: () => {
        setHelpOpen((v) => !v);
      },
      toggleProgress: () => {
        setProgressOpen((v) => !v);
      },
      toggleBanner: () => {
        setBannerCompact((v) => !v);
      },
      openEvaluation: setEvaluationTarget,
      closeEvaluation: () => {
        setEvaluationTarget(undefined);
      },
      openQuit: setQuitRuns,
      closeQuit: () => {
        setQuitRuns(undefined);
      },
    }),
    []
  );

  const overlayOpen = progressOpen || helpOpen || evaluationTarget !== undefined || quitRuns !== undefined;

  const api = useMemo<OverlayApi>(
    () => ({
      ...actions,
      helpOpen,
      progressOpen,
      evaluationTarget,
      quitRuns,
      overlayOpen,
      promptActive: claims > 0,
      modalOpen: overlayOpen || claims > 0,
      escapeClaimed: escapeClaims > 0,
      bannerCompact,
      claimPrompt,
      claimEscape,
    }),
    [
      actions,
      helpOpen,
      progressOpen,
      evaluationTarget,
      quitRuns,
      overlayOpen,
      claims,
      escapeClaims,
      bannerCompact,
      claimPrompt,
      claimEscape,
    ]
  );

  return <OverlayContext.Provider value={api}>{children}</OverlayContext.Provider>;
};

export const useOverlayState = (): OverlayApi => {
  const ctx = useContext(OverlayContext);
  if (!ctx) throw new Error('useOverlayState: must be used inside <UiStateProvider>');
  return ctx;
};

/** Like {@link useOverlayState} but `undefined` outside a provider — for prompts rendered in isolation. */
export const useOptionalOverlayState = (): OverlayApi | undefined => useContext(OverlayContext);

const FocusedRunContext = createContext<FocusedRunApi | undefined>(undefined);

const FocusedRunProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [focusedRunCtx, setFocusedRunContext] = useState<FocusedRunCtx | undefined>(undefined);

  const api = useMemo<FocusedRunApi>(
    () => ({
      setFocusedRunContext,
      focusedRunProjectLabel: focusedRunCtx?.projectLabel,
      focusedRunSprintId: focusedRunCtx?.sprintId,
      focusedRunSprintLabel: focusedRunCtx?.sprintLabel,
    }),
    [focusedRunCtx]
  );

  return <FocusedRunContext.Provider value={api}>{children}</FocusedRunContext.Provider>;
};

export const useFocusedRun = (): FocusedRunApi => {
  const ctx = useContext(FocusedRunContext);
  if (!ctx) throw new Error('useFocusedRun: must be used inside <UiStateProvider>');
  return ctx;
};

const YankProviderContext = createContext<YankProviderApi | undefined>(undefined);

const createYankRegistry = (): YankProviderApi => {
  let provider: ActiveTaskSummaryProvider | undefined;
  return {
    setActiveTaskSummaryProvider: (next) => {
      provider = next;
    },
    getActiveTaskSummary: () => {
      try {
        return provider?.();
      } catch {
        return undefined;
      }
    },
  };
};

const YankProviderRegistryProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [registry] = useState(createYankRegistry);
  return <YankProviderContext.Provider value={registry}>{children}</YankProviderContext.Provider>;
};

export const useYankProvider = (): YankProviderApi => {
  const ctx = useContext(YankProviderContext);
  if (!ctx) throw new Error('useYankProvider: must be used inside <UiStateProvider>');
  return ctx;
};

const SessionScratchContext = createContext<SessionScratchApi | undefined>(undefined);

const SessionScratchProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [sessionRepositoryId, setSessionRepositoryId] = useState<RepositoryId | undefined>(undefined);

  const api = useMemo<SessionScratchApi>(
    () => ({ sessionRepositoryId, setSessionRepositoryId }),
    [sessionRepositoryId]
  );

  return <SessionScratchContext.Provider value={api}>{children}</SessionScratchContext.Provider>;
};

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
