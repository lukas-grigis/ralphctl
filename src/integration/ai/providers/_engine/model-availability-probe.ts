import type { AiProvider } from '@src/domain/entity/settings.ts';

/**
 * Per-provider gate that narrows the static model catalog down to the models the operator's
 * account can actually run. The static catalogs in `src/domain/value/settings-models/` stay the
 * full official list; this probe filters the *picker* surface so users don't pick a model their
 * account can't reach.
 *
 * Contract: the probe MUST fail open and MUST NOT throw. Any error — missing config, parse
 * failure, unexpected shape, AbortError — resolves to the full `catalog` unchanged so the picker
 * never blocks or hides everything. It is best-effort and runs outside the chain runtime, so it
 * absorbs cancellation rather than re-throwing it.
 *
 * @public
 */
export interface ModelAvailabilityProbe {
  /**
   * Resolve the subset of `catalog` available to the current account. Always resolves; never
   * rejects. On any error returns `catalog` verbatim (fail open).
   */
  availableModels(catalog: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

/**
 * Registry of {@link ModelAvailabilityProbe}s keyed by {@link AiProvider}. Total over the provider
 * union — every provider supplies a probe (passthrough where no real source exists yet).
 *
 * @public
 */
export type ModelAvailabilityProbeRegistry = Readonly<Record<AiProvider, ModelAvailabilityProbe>>;
