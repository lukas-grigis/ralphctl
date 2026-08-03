import { Result } from '@src/domain/result.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ErrorCode } from '@src/domain/value/error/error-code.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';

/**
 * Optional warn banner published when a failure is absorbed. `cause` is filled in from the
 * absorbed error's message, so callers only supply the stable identity + operator-facing text.
 */
export interface TolerateErrorsBanner {
  /** Dedupe key — concurrent absorptions with the same id collapse into one banner. */
  readonly id: string;
  /** One-line operator-facing explanation of what was skipped and what continues. */
  readonly message: string;
}

export interface TolerateErrorsOpts {
  /**
   * Decides whether a given failure is safe to absorb. Return `true` to swallow the failure and
   * continue with the ctx that entered the wrapper; `false` to let it propagate. Each flow owns
   * its own policy — the wrapper deliberately has no default.
   */
  readonly tolerate: (error: DomainError) => boolean;
  readonly eventBus: EventBus;
  readonly banner?: TolerateErrorsBanner;
}

/**
 * Ctx-generic higher-order element that absorbs a *selected* class of failures from an inner chain
 * so the surrounding sequence carries on. This is the ONE sanctioned shape for error absorption in
 * a chain — the framework has no `onError` primitive, and each flow that needs "keep going past
 * this kind of failure" wraps its sub-chain here with its own `tolerate` predicate rather than
 * hand-rolling a bespoke element (see the sibling `withRepoLock` wrapper for the same pattern).
 *
 * On absorption the inner failure trace is preserved verbatim and the ctx that entered the wrapper
 * flows on unchanged — the inner chain's partial ctx mutations are discarded, so a half-finished
 * sub-chain cannot leak state into the steps that follow.
 *
 * `AbortError` is exempted inside the wrapper: an aborted run always propagates even when
 * `tolerate` would return `true` for it, so no caller can accidentally swallow an operator
 * cancellation. Throws are never caught at all, so a raw `AbortError` throw travels untouched too.
 *
 * The inner element is exposed through the composite-pattern `children` slot so `flattenLeaves`
 * still walks the real step list when the TUI builds its planned-leaf view — without it the
 * wrapper would render as a single opaque step.
 */
export const tolerateErrors = <TCtx>(opts: TolerateErrorsOpts, inner: Element<TCtx>): Element<TCtx> => ({
  name: `continue-on-error(${inner.name})`,
  children: [inner],
  async execute(ctx, signal, onTrace): Promise<ElementResult<TCtx>> {
    const result = await inner.execute(ctx, signal, onTrace);
    if (result.ok) return result;

    const error = result.error.error;
    // Operator cancellation always wins over any caller policy.
    if (error.code === ErrorCode.Aborted) return result;
    if (!opts.tolerate(error)) return result;

    if (opts.banner !== undefined) {
      opts.eventBus.publish({
        type: 'banner-show',
        id: opts.banner.id,
        tier: 'warn',
        message: opts.banner.message,
        cause: error.message,
        at: IsoTimestamp.now(),
      });
    }
    return Result.ok({ ctx, trace: result.error.trace });
  },
});
