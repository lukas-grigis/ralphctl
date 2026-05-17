import { AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Status of a single trace entry — one per element invocation.
 *
 *  - `completed`: the element produced a fresh ctx and returned ok.
 *  - `failed`: the element returned a `DomainError`.
 *  - `skipped`: a sibling failed earlier; this element never ran (synthesised by composites).
 *  - `aborted`: an `AbortSignal` tripped before or during execution.
 */
export type TraceStatus = 'completed' | 'failed' | 'skipped' | 'aborted';

export interface TraceEntry {
  readonly elementName: string;
  readonly status: TraceStatus;
  readonly durationMs: number;
  readonly error?: DomainError;
}

export type Trace = readonly TraceEntry[];

/**
 * Progressive-trace callback. Implementations call this once per element invocation, at the
 * moment the entry becomes final. Composites forward the callback to their children so leaves
 * report progressively as they complete; a composite never reports a self-entry.
 *
 * Synthetic entries the composite constructs itself (`skipped`, `aborted`) MUST also be
 * forwarded so the live event stream matches the final trace exactly.
 */
export type OnTrace = (entry: TraceEntry) => void;

/** Build a synthetic `aborted` trace entry. */
export const abortedEntry = (elementName: string, reason?: string): TraceEntry => ({
  elementName,
  status: 'aborted',
  durationMs: 0,
  error: reason !== undefined ? new AbortError({ elementName, reason }) : new AbortError({ elementName }),
});

/** Build a `skipped` trace entry. */
export const skippedEntry = (elementName: string): TraceEntry => ({
  elementName,
  status: 'skipped',
  durationMs: 0,
});
