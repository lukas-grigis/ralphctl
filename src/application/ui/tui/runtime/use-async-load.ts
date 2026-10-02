/** `useAsyncLoad` — fetch-and-cache helper for views that pull data from a repo on mount. */

import { useEffect, useRef, useState } from 'react';

export type AsyncLoadState<T, E> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'error'; readonly error: E };

export interface UseAsyncLoadResult<T, E> {
  readonly state: AsyncLoadState<T, E>;
  /** Re-run the loader. Resets to `loading`. */
  reload(): void;
}

const LOADING: { readonly kind: 'loading' } = { kind: 'loading' };

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[]): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export const useAsyncLoad = <T, E = unknown>(
  loader: (signal: AbortSignal) => Promise<T>,
  // Caller-supplied dependency list: the hook re-fetches whenever any of these change.
  deps: readonly unknown[],
  errorMap: (err: unknown) => E = (err: unknown) => err as E
): UseAsyncLoadResult<T, E> => {
  const [state, setState] = useState<AsyncLoadState<T, E>>({ kind: 'idle' });
  const [version, setVersion] = useState(0);

  // Capture `loader` and `errorMap` in refs so the effect reads the latest closure WITHOUT re-firing on every render
  // (callers commonly pass fresh arrows).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const errorMapRef = useRef(errorMap);
  errorMapRef.current = errorMap;
  // Deps the settled state was loaded for; the effect only moves to `loading` after the first render with new deps.
  const settledDepsRef = useRef<readonly unknown[] | undefined>(undefined);

  useEffect(() => {
    const depsAtStart = deps;
    const controller = new AbortController();
    let cancelled = false;
    setState({ kind: 'loading' });
    loaderRef
      .current(controller.signal)
      .then((value) => {
        if (cancelled) return;
        settledDepsRef.current = depsAtStart;
        setState({ kind: 'ok', value });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Treat AbortError as a silent cancel rather than an error state — the view is about
        // to unmount or re-fetch; surfacing "aborted" to the user would be confusing.
        if (err instanceof Error && err.name === 'AbortError') return;
        settledDepsRef.current = depsAtStart;
        setState({ kind: 'error', error: errorMapRef.current(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spread of caller-supplied deps is the entire API; loader + errorMap captured via refs above
  }, [version, ...deps]);

  const settledIsStale = (state.kind === 'ok' || state.kind === 'error') && !sameDeps(settledDepsRef.current, deps);
  return {
    state: settledIsStale ? LOADING : state,
    reload(): void {
      setVersion((v) => v + 1);
    },
  };
};
