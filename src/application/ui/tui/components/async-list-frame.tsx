/**
 * `AsyncListFrame` — owns the loading / error / overlay / empty ladder that every view backed by
 * `useAsyncLoad` re-derives by hand: a modal overlay (e.g. the help screen) pre-empts everything,
 * then loading, then error, then an empty placeholder, and only then the view's real content.
 *
 * Renders exactly one of, in this order:
 *
 *   1. `overlay` — when supplied, takes over the whole frame (e.g. `<HelpOverlay />` while the
 *      view's help toggle is open). Nothing else below is evaluated.
 *   2. a `<LoadingRow>` — while `state.kind` is `'loading'` or `'idle'` (the pre-fetch tick before
 *      the effect fires).
 *   3. a `<LoadErrorRow>` — while `state.kind` is `'error'`.
 *   4. `empty` — once loaded (`state.kind === 'ok'`) but the caller reports there's nothing to
 *      show (`isEmpty`). Callers commonly render an `<EmptyState>` here.
 *   5. `children` — the loaded, non-empty case. The only branch where the view's real content
 *      mounts.
 *
 * `isEmpty` is a plain boolean rather than a predicate over `state.value` because "empty" isn't
 * always a direct function of the loaded payload — the sprint picker's emptiness is a derived
 * row count after grouping/filtering, not `state.value.sprints.length === 0`. Callers that DO
 * have a simple predicate can still pass `isEmpty={someList.length === 0}` inline.
 *
 * First consumer: `PickerBody` in `pick-sprint-view.tsx`.
 */

import React from 'react';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';

export interface AsyncListFrameProps<T> {
  /** Takes over the entire frame when supplied — e.g. a modal help overlay. Pre-empts every
   *  other branch, including a concurrent loading/error state. */
  readonly overlay?: React.ReactNode;
  readonly state: AsyncLoadState<T, unknown>;
  /** Spinner label for the loading branch — see DESIGN-SYSTEM.md §8.1 for the copy convention. */
  readonly loadingLabel: string;
  /** One-line failure copy for the error branch. */
  readonly errorMessage: string;
  /** Optional error-row text colour — omit for the default weight. */
  readonly errorColor?: string;
  /** Renders `empty` instead of `children` when `state.kind === 'ok'` and this is `true`. */
  readonly isEmpty: boolean;
  /** Placeholder rendered when loaded data has nothing to show — typically `<EmptyState>`. */
  readonly empty: React.ReactNode;
  /** The view's real content — mounted only once loaded and non-empty. */
  readonly children: React.ReactNode;
}

export function AsyncListFrame<T>({
  overlay,
  state,
  loadingLabel,
  errorMessage,
  errorColor,
  isEmpty,
  empty,
  children,
}: AsyncListFrameProps<T>): React.JSX.Element {
  if (overlay !== undefined) return <>{overlay}</>;
  if (state.kind === 'loading' || state.kind === 'idle') return <LoadingRow label={loadingLabel} />;
  if (state.kind === 'error') {
    return <LoadErrorRow message={errorMessage} {...(errorColor !== undefined ? { color: errorColor } : {})} />;
  }
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}
