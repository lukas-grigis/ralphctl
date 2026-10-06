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

/** One enclosing loop's iteration at the moment an entry or start was recorded. */
export interface LoopIteration {
  readonly loop: string;
  readonly n: number;
}

export interface TraceEntry {
  readonly elementName: string;
  /**
   * Optional human-friendly display label, copied from the source `Element.label` at the moment
   * the entry is recorded. `elementName` remains the canonical identifier; UIs render `label`
   * when present and fall back to `elementName`. Synthetic entries (`skipped`, `aborted`)
   * constructed without an originating element omit this field.
   */
  readonly label?: string;
  readonly status: TraceStatus;
  readonly durationMs: number;
  readonly error?: DomainError;
  /**
   * Enclosing loop iterations, outer-first. Stamped by `loop` as entries pass through it; absent
   * outside any loop.
   */
  readonly iterations?: readonly LoopIteration[];
  /** Id of the nested runner that recorded this entry and already published it; host bridges skip it. */
  readonly forwardedFrom?: string;
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

/** A leaf (or leaf-like hand-written element) is about to run its work. */
export interface StepStart {
  readonly elementName: string;
  readonly label?: string;
  /** Enclosing loop iterations, outer-first — same contract as `TraceEntry.iterations`. */
  readonly iterations?: readonly LoopIteration[];
  /** Same contract as `TraceEntry.forwardedFrom`. */
  readonly forwardedFrom?: string;
}

/**
 * Leaf-started callback. A leaf calls it once it is past its abort check and about to run its use
 * case — never for a pre-aborted, skipped or synthesised entry. Composites forward it exactly like
 * `OnTrace`; it carries no result, so a missing forward only degrades live display, never execution.
 */
export type OnStart = (step: StepStart) => void;

/** Build a synthetic `aborted` trace entry. */
export const abortedEntry = (elementName: string): TraceEntry & { readonly error: AbortError } => ({
  elementName,
  status: 'aborted',
  durationMs: 0,
  error: new AbortError({ elementName }),
});

/** Build a `skipped` trace entry. */
export const skippedEntry = (elementName: string): TraceEntry => ({
  elementName,
  status: 'skipped',
  durationMs: 0,
});
