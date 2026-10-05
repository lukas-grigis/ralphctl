import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

import { abortedEntry, type OnStart, type OnTrace, type Trace } from '@src/application/chain/trace.ts';

export interface ElementSuccess<TCtx> {
  readonly ctx: TCtx;
  readonly trace: Trace;
}

export interface ElementFailure {
  readonly error: DomainError;
  readonly trace: Trace;
}

export type ElementResult<TCtx> = Result<ElementSuccess<TCtx>, ElementFailure>;

/** Which primitive built an element. Absent on hand-written elements. */
export type ElementKind = 'leaf' | 'sequential' | 'loop' | 'guard';

/** The unit of work a subtree runs for — a task in implement, a ticket in refine. */
export interface WorkItemRef {
  readonly kind: 'task' | 'ticket';
  readonly id: string;
}

/** Display-only metadata. The chain never reads it; it shapes how the step tree is presented. */
export interface ElementDisplay {
  /** Bookkeeping step: traced as usual, hidden from the step display unless it fails or is the in-flight leaf. */
  readonly internal?: true;
  /** Marks the root of one work item's subtree (per-task / per-ticket sequential). */
  readonly workItem?: WorkItemRef;
}

/** Optional display metadata for `sequential` and `guard`. */
export interface CompositeOpts {
  readonly label?: string;
  readonly internal?: boolean;
  readonly workItem?: WorkItemRef;
}

/**
 * Composite-pattern component for the chain framework. Concrete elements are built by `leaf`,
 * `sequential`, `loop`, `guard`.
 *
 * Contract for `execute`:
 *  - Success → `Result.ok({ ctx, trace })`. Trace lists every entry the caller should surface,
 *    in execution order.
 *  - Failure → `Result.error({ error, trace })`. Trace ends with the failing entry.
 *  - On `signal.aborted` → fail with a final `aborted` entry whose error is an `AbortError`.
 *  - `onStart` fires when a leaf begins its work; composites and hand-written wrappers forward it
 *    exactly like `onTrace` (see `OnStart`).
 *
 * `children` exposes composite structure so callers can walk the tree without executing it —
 * `buildPlanTree` (`plan-tree.ts`) derives the upfront step plan from it. Leaves omit / return
 * `[]`; composites return their immediate children; loop returns its body (one element).
 *
 * `kind`, `display` and `maxIterations` are display metadata: set by the primitives (the latter
 * two only when the caller passed them), absent on hand-written elements, never read by execution.
 */
export interface Element<TCtx> {
  readonly name: string;
  /**
   * Optional human-friendly display label. The chain framework treats `name` as the canonical
   * identifier (used for dedupe, trace correlation, plan/trace merge) — `label` exists purely so
   * UI surfaces can render something more readable without forcing flow authors to bake display
   * concerns into the element name. When absent, callers fall back to `name`. Composites carry
   * one too when their builder was given it.
   *
   * Example: a per-repo preflight leaf keeps `name = 'preflight-task-1-/abs/path'` (stable +
   * unique across the multi-repo iteration) but exposes `label = 'preflight · my-repo'` for the
   * TUI rail.
   */
  readonly label?: string;
  readonly kind?: ElementKind;
  readonly display?: ElementDisplay;
  /** Loop only: the explicit cap, else the caller's display-only cap; absent when neither was passed. */
  readonly maxIterations?: number;
  readonly children?: ReadonlyArray<Element<TCtx>>;
  execute(ctx: TCtx, signal?: AbortSignal, onTrace?: OnTrace, onStart?: OnStart): Promise<ElementResult<TCtx>>;
}

/**
 * Build the optional `label` / `display` keys for a primitive. Keys stay absent when not passed so
 * exact-equality assertions on elements and trace entries are unaffected.
 */
export const displayMeta = (opts: {
  readonly label?: string | undefined;
  readonly internal?: boolean | undefined;
  readonly workItem?: WorkItemRef | undefined;
}): { readonly label?: string; readonly display?: ElementDisplay } => {
  const display: ElementDisplay = {
    ...(opts.internal === true ? { internal: true as const } : {}),
    ...(opts.workItem !== undefined ? { workItem: opts.workItem } : {}),
  };
  return {
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    ...(Object.keys(display).length > 0 ? { display } : {}),
  };
};

/** Attach display metadata to an already-built element; execution is untouched. */
export const withDisplay = <TCtx>(element: Element<TCtx>, opts: CompositeOpts): Element<TCtx> => {
  const meta = displayMeta(opts);
  return {
    ...element,
    ...(meta.label !== undefined ? { label: meta.label } : {}),
    ...(meta.display !== undefined ? { display: { ...element.display, ...meta.display } } : {}),
  };
};

/**
 * Walk an element tree in DFS order and return its leaf elements (those with no `children`).
 * Pure / total — every reachable node is either a leaf returned in order or a composite whose
 * children are recursively descended. Used by the TUI's execute view to derive the planned-step
 * list at chain-construction time, and by the plan-tree tests as the leaf-order oracle.
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
  return Result.error({ error: entry.error, trace: [entry] });
};
