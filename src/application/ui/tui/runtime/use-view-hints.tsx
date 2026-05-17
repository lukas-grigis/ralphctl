/**
 * Per-view local hint registry. A view declares "what local keys are meaningful here" once, and
 * the status bar reads the active set via context.
 *
 * Why a context instead of prop drilling: ViewShell renders the StatusBar; intermediate
 * components don't know which keys their leaf children care about. A small registry let us keep
 * StatusBar dumb (it just renders the current set) and views explicit (one `useViewHints` call).
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface ViewHint {
  readonly keys: string;
  readonly label: string;
}

interface HintsRegistryApi {
  readonly hints: readonly ViewHint[];
  set(id: number, hints: readonly ViewHint[]): void;
  remove(id: number): void;
}

const HintsContext = createContext<HintsRegistryApi | undefined>(undefined);

// Views call `useViewHints([...])` with a freshly-allocated array each render. Without a
// content-based bail-out the effect would loop: fresh array → registry update → new context
// value → caller re-renders → fresh array → ... (Maximum update depth exceeded.)
const hintsEqual = (a: readonly ViewHint[], b: readonly ViewHint[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.keys !== y.keys || x.label !== y.label) return false;
  }
  return true;
};

export const HintsProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  // Map id → hints; merge in registration order on read.
  const [registry, setRegistry] = useState<ReadonlyMap<number, readonly ViewHint[]>>(new Map());

  const set = useCallback((id: number, hints: readonly ViewHint[]): void => {
    setRegistry((prev) => {
      const cur = prev.get(id);
      if (cur !== undefined && hintsEqual(cur, hints)) return prev;
      const next = new Map(prev);
      next.set(id, hints);
      return next;
    });
  }, []);

  const remove = useCallback((id: number): void => {
    setRegistry((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const merged = useMemo<readonly ViewHint[]>(() => [...registry.values()].flat(), [registry]);

  const api = useMemo<HintsRegistryApi>(() => ({ hints: merged, set, remove }), [merged, set, remove]);

  return <HintsContext.Provider value={api}>{children}</HintsContext.Provider>;
};

let nextHintId = 1;

/**
 * Register the calling view's local hints. The hints render in the status bar until the view
 * unmounts or supplies a new array. Pass an empty array to advertise no local hints (the global
 * row is still rendered).
 *
 * Implementation note: callers pass a freshly-allocated array on every render. We split the
 * registration into two effects so the cleanup only runs on unmount — running it on every
 * render would mutate the registry → re-render → effect re-runs → infinite loop. The
 * content-sync effect short-circuits at the registry level when the array contents are equal.
 */
export const useViewHints = (hints: readonly ViewHint[]): void => {
  const ctx = useContext(HintsContext);
  // Stable id per component instance.
  const [id] = useState<number>(() => nextHintId++);

  // Always read the latest ctx through a ref so effect callbacks aren't recreated when the
  // context value changes.
  const ctxRef = useRef<HintsRegistryApi | undefined>(ctx);
  ctxRef.current = ctx;

  // Mount/unmount: register cleanup once. We use the ref so we always remove against the
  // currently-mounted provider, not whichever one was around when this effect was scheduled.
  useEffect(() => {
    return (): void => {
      ctxRef.current?.remove(id);
    };
  }, [id]);

  // Content sync: pushes the latest hints into the registry. `ctx.set` short-circuits when the
  // content matches, so re-runs from fresh-array refs are no-ops at the registry level.
  useEffect(() => {
    ctxRef.current?.set(id, hints);
  }, [id, hints]);
};

/** Read the current merged hint set. Used by StatusBar. */
export const useActiveHints = (): readonly ViewHint[] => {
  const ctx = useContext(HintsContext);
  return ctx?.hints ?? [];
};
