/**
 * `useAsyncLoad` — fetch-and-cache helper for views that pull data from a repo on mount. Tracks
 * `loading` / `error` / `value` so the view can render loading + error states uniformly.
 *
 * Discriminated state means consumers narrow once and stop checking: `state.kind === 'ok'`
 * gives them `value`; `state.kind === 'error'` gives them `error`.
 *
 * Cancellation: the loader receives an `AbortSignal` keyed to the current fetch. On unmount
 * (or when `deps` change and we trigger a fresh fetch) the previous signal is aborted, so
 * callers that thread the signal into their underlying fetch / repo call can short-circuit
 * real work — not just suppress state writes. Callers that ignore the signal still benefit
 * from the existing `cancelled` flag (state writes are gated; in-flight work just keeps
 * running until natural completion, then gets discarded).
 */

import { useEffect, useState } from 'react';

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

export const useAsyncLoad = <T, E = unknown>(
  loader: (signal: AbortSignal) => Promise<T>,
  // Caller-supplied dependency list: the hook re-fetches whenever any of these change.
  deps: readonly unknown[],
  errorMap: (err: unknown) => E = (err: unknown) => err as E
): UseAsyncLoadResult<T, E> => {
  const [state, setState] = useState<AsyncLoadState<T, E>>({ kind: 'idle' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setState({ kind: 'loading' });
    loader(controller.signal)
      .then((value) => {
        if (cancelled) return;
        setState({ kind: 'ok', value });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Treat AbortError as a silent cancel rather than an error state — the view is about
        // to unmount or re-fetch; surfacing "aborted" to the user would be confusing.
        if (err instanceof Error && err.name === 'AbortError') return;
        setState({ kind: 'error', error: errorMap(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [version, ...deps]);

  return {
    state,
    reload(): void {
      setVersion((v) => v + 1);
    },
  };
};
