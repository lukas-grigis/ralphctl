/**
 * View-hints context — the contract for view-local keyboard hints.
 *
 * Any view that handles its own keys calls `useViewHints([...])` to publish
 * them. `<KeyboardHints>` (rendered by `<ViewShell>`) subscribes and displays
 * them at the bottom of the view body, right above the StatusBar.
 *
 * Ported from src/integration/ui/tui/views/view-hints-context.tsx — no legacy src/ imports.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface Hint {
  readonly key: string;
  readonly action: string;
}

interface HintsContextValue {
  readonly hints: readonly Hint[];
  readonly publish: (hints: readonly Hint[]) => () => void;
}

const HintsContext = createContext<HintsContextValue | null>(null);

export function ViewHintsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [registrations, setRegistrations] = useState<Map<symbol, readonly Hint[]>>(() => new Map());

  const publish = useCallback((hints: readonly Hint[]) => {
    const id = Symbol('view-hints');
    setRegistrations((prev) => {
      const next = new Map(prev);
      next.set(id, hints);
      return next;
    });
    return (): void => {
      setRegistrations((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    };
  }, []);

  const hints = useMemo((): readonly Hint[] => {
    const flat: Hint[] = [];
    for (const list of registrations.values()) {
      flat.push(...list);
    }
    return flat;
  }, [registrations]);

  const value = useMemo(() => ({ hints, publish }), [hints, publish]);

  return <HintsContext.Provider value={value}>{children}</HintsContext.Provider>;
}

/**
 * Publish a set of hints for the current view. Pass a stable array
 * (memoise if built from props/state) so the effect doesn't re-publish
 * on every render. A null context (tests) is a safe no-op.
 */
export function useViewHints(hints: readonly Hint[]): void {
  const publish = useContext(HintsContext)?.publish;
  useEffect(() => {
    if (publish === undefined) return;
    return publish(hints);
  }, [publish, hints]);
}

/** Read current hints — used by `<KeyboardHints>`. */
export function useActiveHints(): readonly Hint[] {
  const ctx = useContext(HintsContext);
  return ctx?.hints ?? [];
}
