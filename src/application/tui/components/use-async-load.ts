/**
 * `useAsyncLoad` — minimal "load once on mount, with cancel guard" hook.
 *
 * The 4 browse list views (`sprint-list`, `project-list`, `task-list`,
 * `ticket-list`) all repeat the same skeleton:
 *
 * ```ts
 * const [data, setData] = useState<T | null>(null);
 * const [error, setError] = useState<string | null>(null);
 *
 * useEffect(() => {
 *   const cancel = { current: false };
 *   void (async () => {
 *     try {
 *       const value = await loader();
 *       if (cancel.current) return;
 *       setData(value);
 *     } catch (err) {
 *       if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
 *     }
 *   })();
 *   return () => { cancel.current = true; };
 * }, []);
 * ```
 *
 * This hook collapses that to one call. Loader errors surface as
 * `error: string` (the message); successful loads populate `data`. The
 * unmount guard prevents `setState`-after-unmount warnings on fast
 * navigation.
 */
import { useEffect, useRef, useState } from 'react';

export interface AsyncLoadState<T> {
  readonly data: T | null;
  readonly error: string | null;
}

export function useAsyncLoad<T>(loader: () => Promise<T>): AsyncLoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest-loader ref so a re-render with a new closure doesn't trigger a
  // refetch — the effect runs once on mount, like the hand-rolled version.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const cancel = { current: false };
    void (async () => {
      try {
        const value = await loaderRef.current();
        if (cancel.current) return;
        setData(value);
      } catch (err) {
        if (!cancel.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel.current = true;
    };
  }, []);

  return { data, error };
}
