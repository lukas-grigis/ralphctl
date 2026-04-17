/**
 * View-hints context — the contract for view-local keyboard hints.
 *
 * Any view that handles its own keys calls `useViewHints([...])` to publish
 * them. `<KeyboardHints>` (rendered by `<ViewShell>`) subscribes and displays
 * them at the bottom of the view body, right above the StatusBar.
 *
 * StatusBar stays pure — it only ever shows *global* hotkeys. No more
 * duplication between the view footer and the status bar.
 *
 * Hints are scoped per-view: mounting publishes, unmounting clears. The
 * provider lives in `<ViewShell>`, so hints reset every time the router
 * swaps views.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface Hint {
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

  // Flatten every active registration into a single ordered list. Order is
  // insertion order — the outermost `<ViewShell>` publishes first, any nested
  // sub-views publish after.
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
 * Publish a set of hints for the current view. Pass a *stable* array (memoise
 * if built from props/state) so the effect doesn't re-publish on every render.
 * A `null` context (tests mounting components in isolation) is a safe noop.
 *
 * Critical: depend ONLY on the stable `publish` callback, not the whole ctx.
 * The provider's value object changes whenever registrations mutate (because
 * the memoised value recomputes the flattened hints list), and an effect
 * depending on `ctx` would loop: publish → setState → new ctx → effect re-runs
 * → publish again.
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
