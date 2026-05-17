import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner, RunnerEvent } from '@src/application/chain/run/runner.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

export interface RunnerBridgeOpts {
  readonly flowId: string;
  /** Wall-clock used to stamp event timestamps. Tests pass a frozen value. */
  readonly clock?: () => IsoTimestamp;
}

/**
 * Subscribe a {@link Runner}'s lifecycle to an {@link EventBus}, translating
 * each `RunnerEvent` into the matching {@link AppEvent} variant.
 *
 * Why a bridge rather than direct integration: the chain runner stays
 * platform-pure (no EventBus dependency, no AppEvent vocabulary) and tests
 * that exercise the runner in isolation don't need to provide a bus. The
 * launcher is the integration boundary that knows the `flowId` (which
 * `Runner.id` does not carry) and pairs the two together.
 *
 * Returns the unsubscribe function returned by `runner.subscribe(...)`.
 */
export const bridgeRunnerToEventBus = (
  runner: Runner<unknown>,
  bus: EventBus,
  opts: RunnerBridgeOpts
): (() => void) => {
  const clock = opts.clock ?? IsoTimestamp.now;

  // Auto-detach on terminal so every dead Implement run drops its listener instead of
  // accumulating on `runner.subscribe`'s internal Set across a long multi-run session.
  //
  // `unsub` doubles as state: `null` before subscribe completes or after detach; a function
  // while the subscription is live. The listener can fire synchronously during
  // `runner.subscribe(...)` for an already-terminal runner (via `replayTo`); when that happens
  // `unsub` is still null inside `detach()`, so we set `pendingDetach` and call detach again
  // after subscribe returns. Without this finalise step, sync-replay terminals would leak.
  let unsub: (() => void) | null = null;
  let pendingDetach = false;
  const detach = (): void => {
    if (unsub === null) {
      pendingDetach = true;
      return;
    }
    const fn = unsub;
    unsub = null;
    fn();
  };

  unsub = runner.subscribe((event: RunnerEvent<unknown>) => {
    const at = clock();
    switch (event.type) {
      case 'started':
        bus.publish({ type: 'chain-started', chainId: runner.id, flowId: opts.flowId, at });
        return;
      case 'step': {
        const { entry } = event;
        if (entry.status === 'completed') {
          bus.publish({
            type: 'chain-step-completed',
            chainId: runner.id,
            elementName: entry.elementName,
            durationMs: entry.durationMs,
            at,
          });
          return;
        }
        if (entry.status === 'failed' && entry.error !== undefined) {
          bus.publish({
            type: 'chain-step-failed',
            chainId: runner.id,
            elementName: entry.elementName,
            error: entry.error,
            durationMs: entry.durationMs,
            at,
          });
          return;
        }
        // 'skipped' / 'aborted' steps emit only the chain-level event below.
        return;
      }
      case 'completed':
        bus.publish({ type: 'chain-completed', chainId: runner.id, at });
        detach();
        return;
      case 'failed':
        bus.publish({ type: 'chain-failed', chainId: runner.id, error: event.error, at });
        detach();
        return;
      case 'aborted':
        bus.publish({ type: 'chain-aborted', chainId: runner.id, at });
        detach();
    }
  });

  if (pendingDetach) detach();

  return detach;
};
