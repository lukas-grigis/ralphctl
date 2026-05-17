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
 */

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';

interface UiStateApi {
  readonly helpOpen: boolean;
  /** `true` whenever any caller currently holds a {@link claimPrompt} release token. */
  readonly promptActive: boolean;
  toggleHelp(): void;
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
   * Session-scoped pin for the repository the user most recently picked inside one of the
   * project-scoped flows (detect-scripts / detect-skills / readiness). Cleared when the TUI
   * exits; not persisted to disk. Threaded via `launchFlow.extras.repositoryId` so subsequent
   * flows skip the repo prompt for the rest of the session.
   */
  readonly sessionRepositoryId: RepositoryId | undefined;
  setSessionRepositoryId(id: RepositoryId | undefined): void;
}

const UiStateContext = createContext<UiStateApi | undefined>(undefined);

export const UiStateProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  const [helpOpen, setHelpOpen] = useState(false);
  const [claims, setClaims] = useState(0);
  const [sessionRepositoryId, setSessionRepositoryIdState] = useState<RepositoryId | undefined>(undefined);

  const toggleHelp = useCallback(() => {
    setHelpOpen((v) => !v);
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

  const setSessionRepositoryId = useCallback((id: RepositoryId | undefined) => {
    setSessionRepositoryIdState(id);
  }, []);

  const api = useMemo<UiStateApi>(
    () => ({
      helpOpen,
      promptActive: claims > 0,
      toggleHelp,
      claimPrompt,
      sessionRepositoryId,
      setSessionRepositoryId,
    }),
    [helpOpen, claims, toggleHelp, claimPrompt, sessionRepositoryId, setSessionRepositoryId]
  );

  return <UiStateContext.Provider value={api}>{children}</UiStateContext.Provider>;
};

export const useUiState = (): UiStateApi => {
  const ctx = useContext(UiStateContext);
  if (!ctx) throw new Error('useUiState: must be used inside <UiStateProvider>');
  return ctx;
};
