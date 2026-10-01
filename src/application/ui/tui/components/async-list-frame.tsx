/**
 * `AsyncListFrame` — owns the loading / error / overlay / empty ladder that every view backed by `useAsyncLoad`
 * re-derives by hand: a full-frame overlay (e.g. a confirm card) pre-empts everything, then loading, then error, then
 * the empty placeholder, and only then `children`.
 */

import React from 'react';
import { LoadErrorRow, LoadingRow } from '@src/application/ui/tui/components/async-rows.tsx';
import type { AsyncLoadState } from '@src/application/ui/tui/runtime/use-async-load.ts';

export interface AsyncListFrameProps<T> {
  /**
   * Takes over the entire frame when supplied — e.g. a confirm card. Pre-empts every other branch, including a
   * concurrent loading/error state.
   */
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
