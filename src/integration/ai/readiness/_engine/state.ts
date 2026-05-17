import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { ToolArtifacts } from '@src/integration/ai/readiness/_engine/tool-artifacts.ts';

/**
 * Outcome of an readiness probe run for a single (Repository, Tool) pair. Re-evaluated on
 * demand — the domain has no "stale" concept; the filesystem is the source of truth and the
 * latest probe wins.
 *
 *  - `unknown`  — the probe has never been run for this pair
 *  - `absent`   — the probe ran and found nothing
 *  - `present`  — the probe ran and surfaced artifacts (the discriminated `tool` field on
 *                 `artifacts` matches the tool the probe was asked about)
 */
export type ReadinessState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'absent'; readonly evaluatedAt: IsoTimestamp }
  | { readonly kind: 'present'; readonly evaluatedAt: IsoTimestamp; readonly artifacts: ToolArtifacts };

export const unknownState: ReadinessState = { kind: 'unknown' };

export const absentState = (evaluatedAt: IsoTimestamp): ReadinessState => ({ kind: 'absent', evaluatedAt });

export const presentState = (evaluatedAt: IsoTimestamp, artifacts: ToolArtifacts): ReadinessState => ({
  kind: 'present',
  evaluatedAt,
  artifacts,
});
