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
 * ## Aggregator backends may return models outside `catalog`
 *
 * "Narrows" describes the single-vendor case, where the static catalog is the vendor's own fixed
 * list and the probe only answers which of them the account may run. An AGGREGATOR backend
 * (`opencode`) inverts that: its reachable ids depend on which upstream providers the operator
 * has authenticated, so no static list can be a superset and intersecting against one would hide
 * every model the operator actually pays for. Such a probe MAY return ids absent from `catalog`,
 * provided it still fails open to `catalog` on every error path. The return value is always "the
 * models to offer in the picker" — for aggregators that is the CLI's own live answer.
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
 * Why a probe fell open to the shipped catalog instead of answering from the live source.
 *
 *  - `probe-failed` — the source could not be consulted at all: binary absent from PATH, non-zero
 *    exit (usually "not authenticated"), spawn error, or the wall-clock cap tripping.
 *  - `probe-aborted` — the caller's signal fired before the source answered.
 *  - `empty-answer` — the source answered, but nothing in it survived id-shape filtering.
 *
 * @public
 */
export type ModelProbeDegradationReason = 'probe-failed' | 'probe-aborted' | 'empty-answer';

/** One fail-open event: which provider degraded, why, and the raw detail worth logging. @public */
export interface ModelProbeDegradation {
  readonly provider: AiProvider;
  readonly reason: ModelProbeDegradationReason;
  /** Human-readable cause (error message, exit description) — safe to put in a log line. */
  readonly detail: string;
}

/**
 * Optional observability seam for {@link ModelAvailabilityProbe} implementations that fail open to
 * a catalog which is NOT the vendor's full list — for those, a fail-open silently shrinks the
 * picker and the operator deserves a trace. `opencode` is the case that motivated this: its
 * shipped catalog is only the zero-auth free tier, so a transient probe failure makes every paid
 * model an authenticated operator can reach disappear from the picker.
 *
 * Implementations MUST NOT throw — the probe contract ("never rejects") holds through this
 * callback. The composition root wires it to `Logger.warn`.
 *
 * @public
 */
export type ModelProbeDegradationSink = (degradation: ModelProbeDegradation) => void;

/**
 * Registry of {@link ModelAvailabilityProbe}s keyed by {@link AiProvider}. Total over the provider
 * union — every provider supplies a probe (passthrough where no real source exists yet).
 *
 * @public
 */
export type ModelAvailabilityProbeRegistry = Readonly<Record<AiProvider, ModelAvailabilityProbe>>;
