import { Result } from 'typescript-result';

import type { ChainTraceEntry, ElementResult, OnTraceCallback } from './element.ts';
import { Element, skippedEntry } from './element.ts';

/**
 * Run children in order, threading `ctx` through each.
 *
 * Semantics:
 * - Empty children list: returns the input ctx unchanged with an empty trace.
 * - Each child receives the context produced by its predecessor.
 * - On the first failing child, remaining children are not executed; their
 *   names appear in the trace with `status: 'skipped'`.
 * - On `signal.aborted` mid-flight, the in-flight child contributes its own
 *   trace (typically with `'aborted'`) and remaining children are skipped.
 *   If the signal is observed BEFORE invoking the next child, that child's
 *   entry is recorded as `'aborted'` rather than `'skipped'` to make the
 *   cancellation point explicit.
 */
export class Sequential<TCtx> extends Element<TCtx> {
  private readonly children: readonly Element<TCtx>[];

  constructor(name: string, children: readonly Element<TCtx>[]) {
    super(name);
    this.children = children;
  }

  protected override async run(
    ctx: TCtx,
    signal?: AbortSignal,
    onTrace?: OnTraceCallback
  ): Promise<ElementResult<TCtx>> {
    const trace: ChainTraceEntry[] = [];
    let currentCtx = ctx;

    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i];
      if (!child) continue; // Defensive: noUncheckedIndexedAccess

      if (signal?.aborted) {
        // Mark the would-be-next child as aborted, the rest as skipped.
        const abortedEntry: ChainTraceEntry = {
          stepName: child.name,
          status: 'aborted' as const,
          durationMs: 0,
          error: { code: 'aborted', message: 'Operation aborted' },
        };
        trace.push(abortedEntry);
        onTrace?.(abortedEntry);
        for (let j = i + 1; j < this.children.length; j++) {
          const skipped = this.children[j];
          if (skipped) {
            const entry = skippedEntry(skipped.name);
            trace.push(entry);
            onTrace?.(entry);
          }
        }
        return Result.error({
          error: { code: 'aborted', message: 'Operation aborted' },
          trace,
        });
      }

      // Forward onTrace so the child's leaf entries surface progressively.
      const childResult = await child.execute(currentCtx, signal, onTrace);
      if (!childResult.ok) {
        trace.push(...childResult.error.trace);
        for (let j = i + 1; j < this.children.length; j++) {
          const skipped = this.children[j];
          if (skipped) {
            const entry = skippedEntry(skipped.name);
            trace.push(entry);
            onTrace?.(entry);
          }
        }
        return Result.error({ error: childResult.error.error, trace });
      }

      trace.push(...childResult.value.trace);
      currentCtx = childResult.value.ctx;
    }

    return Result.ok({ ctx: currentCtx, trace });
  }
}
