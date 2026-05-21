import { Result } from '@src/domain/result.ts';
import { type AbortError } from '@src/domain/value/error/abort-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

import { abortedEntry, type OnTrace, type Trace } from '@src/application/chain/trace.ts';

export interface ElementSuccess<TCtx> {
  readonly ctx: TCtx;
  readonly trace: Trace;
}

export interface ElementFailure {
  readonly error: DomainError;
  readonly trace: Trace;
}

export type ElementResult<TCtx> = Result<ElementSuccess<TCtx>, ElementFailure>;

/**
 * Composite-pattern component for the chain framework. Concrete elements are built by `leaf`,
 * `sequential`, `loop`, `guard`.
 *
 * Contract for `execute`:
 *  - Success → `Result.ok({ ctx, trace })`. Trace lists every entry the caller should surface,
 *    in execution order.
 *  - Failure → `Result.error({ error, trace })`. Trace ends with the failing entry.
 *  - On `signal.aborted` → fail with a final `aborted` entry whose error is an `AbortError`.
 *
 * `children` exposes composite structure so callers can walk the tree without executing it —
 * used by the TUI to render the *full* expected plan upfront (pending glyphs for unstarted
 * steps) instead of only the trace of what has already run. Leaves omit / return `[]`;
 * composites return their immediate children. Loop returns its body (one element) — operators
 * never see the iteration count in the plan, just the body shape.
 */
export interface Element<TCtx> {
  readonly name: string;
  /**
   * Optional human-friendly display label. The chain framework treats `name` as the canonical
   * identifier (used for dedupe, trace correlation, plan/trace merge) — `label` exists purely so
   * UI surfaces can render something more readable without forcing flow authors to bake display
   * concerns into the element name. When absent, callers fall back to `name`.
   *
   * Example: a per-repo preflight leaf keeps `name = 'preflight-task-1-/abs/path'` (stable +
   * unique across the multi-repo iteration) but exposes `label = 'preflight · my-repo'` for the
   * TUI rail.
   */
  readonly label?: string;
  readonly children?: ReadonlyArray<Element<TCtx>>;
  execute(ctx: TCtx, signal?: AbortSignal, onTrace?: OnTrace): Promise<ElementResult<TCtx>>;
}

/**
 * Walk an element tree in DFS order and return its leaf elements (those with no `children`).
 * Pure / total — every reachable node is either a leaf returned in order or a composite whose
 * children are recursively descended. Used by the TUI's execute view to derive the planned-step
 * list at chain-construction time.
 */
export const flattenLeaves = <TCtx>(element: Element<TCtx>): ReadonlyArray<Element<TCtx>> => {
  const kids = element.children;
  if (kids === undefined || kids.length === 0) return [element];
  return kids.flatMap((c) => flattenLeaves(c));
};

export const checkAborted = <TCtx>(
  name: string,
  signal: AbortSignal | undefined,
  onTrace: OnTrace | undefined
): ElementResult<TCtx> | undefined => {
  if (!signal?.aborted) return undefined;
  const entry = abortedEntry(name);
  onTrace?.(entry);
  return Result.error({ error: entry.error as AbortError, trace: [entry] });
};
