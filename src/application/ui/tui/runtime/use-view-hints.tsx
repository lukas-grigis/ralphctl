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
  /**
   * Set of global hint `keys` strings that should be hidden from the status bar while at least
   * one view requests it. The status bar filters `GLOBAL_HINTS` against this set, leaving the
   * local hint list untouched. Used by views whose locally-active surface contradicts a global
   * hint (e.g. the Review-step scroll widget hides the global `↑/↓ scroll` hint when the
   * description fits and arrows are inert).
   */
  readonly suppressedGlobalKeys: ReadonlySet<string>;
  set(id: number, hints: readonly ViewHint[]): void;
  remove(id: number): void;
  setSuppressed(id: number, keys: readonly string[]): void;
  removeSuppressed(id: number): void;
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

const keysEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

export const HintsProvider = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => {
  // Map id → hints; merge in registration order on read.
  const [registry, setRegistry] = useState<ReadonlyMap<number, readonly ViewHint[]>>(new Map());
  // Map id → suppressed global hint keys. Merged into a single set on read.
  const [suppressions, setSuppressions] = useState<ReadonlyMap<number, readonly string[]>>(new Map());

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

  const setSuppressed = useCallback((id: number, keys: readonly string[]): void => {
    setSuppressions((prev) => {
      const cur = prev.get(id);
      if (cur !== undefined && keysEqual(cur, keys)) return prev;
      if (cur === undefined && keys.length === 0) return prev;
      const next = new Map(prev);
      if (keys.length === 0) {
        next.delete(id);
      } else {
        next.set(id, keys);
      }
      return next;
    });
  }, []);

  const removeSuppressed = useCallback((id: number): void => {
    setSuppressions((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const merged = useMemo<readonly ViewHint[]>(() => [...registry.values()].flat(), [registry]);
  const mergedSuppressed = useMemo<ReadonlySet<string>>(
    () => new Set([...suppressions.values()].flat()),
    [suppressions]
  );

  const api = useMemo<HintsRegistryApi>(
    () => ({
      hints: merged,
      suppressedGlobalKeys: mergedSuppressed,
      set,
      remove,
      setSuppressed,
      removeSuppressed,
    }),
    [merged, mergedSuppressed, set, remove, setSuppressed, removeSuppressed]
  );

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

/**
 * Suppress one or more global hints by their `keys` string while this component is mounted (or
 * while `keys` is non-empty). Passing an empty array clears the suppression. Used when a view
 * temporarily owns a key combo whose default meaning the global hint advertises — the global
 * hint disappears so the footer never lies about what `↑/↓` does on this screen.
 *
 * Other views are unaffected; suppressions are scoped per component instance, removed on
 * unmount, and merged into a single set the StatusBar filters GLOBAL_HINTS against.
 */
export const useSuppressGlobalHints = (keys: readonly string[]): void => {
  const ctx = useContext(HintsContext);
  const [id] = useState<number>(() => nextHintId++);

  const ctxRef = useRef<HintsRegistryApi | undefined>(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    return (): void => {
      ctxRef.current?.removeSuppressed(id);
    };
  }, [id]);

  // Push the latest set into the registry every render. `setSuppressed` short-circuits when
  // contents match, so a fresh-array ref on a steady caller is a no-op at the registry level.
  useEffect(() => {
    ctxRef.current?.setSuppressed(id, keys);
  }, [id, keys]);
};

/** Read the suppressed global hint set. Used by StatusBar to filter GLOBAL_HINTS. */
export const useSuppressedGlobalKeys = (): ReadonlySet<string> => {
  const ctx = useContext(HintsContext);
  return ctx?.suppressedGlobalKeys ?? new Set<string>();
};
