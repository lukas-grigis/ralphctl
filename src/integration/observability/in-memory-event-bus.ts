import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/**
 * Hard guardrail on the live subscriber count. NOT a functional limit — every subscriber that
 * crosses it still receives events; the cap is a leak forcing-function. The legitimate steady
 * state of a single TUI session is well under 50: the log forwarder, the notification
 * subscriber, a handful of UI hooks (`useEventBus`, sinks), plus one auto-detaching
 * `bridgeRunnerToEventBus` listener per *live* runner — bounded by the `[1,5]` parallel-branch
 * cap plus the prologue / epilogue / distill sub-runners. Set generously above that so the warning
 * only ever trips on a real listener leak (subscribers added per task × wave × round whose
 * unsubscribe was discarded), never on legitimate concurrency.
 */
const LISTENER_LEAK_THRESHOLD = 300;

/**
 * Default {@link EventBus} adapter. Synchronous fan-out, no buffering, no
 * replay — each subscriber sees only events published after it attached.
 *
 * A thrown handler is logged via `console.warn` so it does not stall
 * delivery to the remaining subscribers (mirrors the chain runner's
 * listener-isolation policy).
 *
 * Self-bounding: the live handler Set is uncapped by design (it is the
 * process-wide chain-progress fan-out), but it warns ONCE — loudly — when it
 * crosses {@link LISTENER_LEAK_THRESHOLD}. A long parallel run that discards a
 * per-branch unsubscribe leaks one closure per task × wave × round; each closure
 * pins its branch runner → forked ctx → trace ring, which is the dominant
 * retainer in the long-session OOM. The warning names the symptom at the seam
 * where it accrues rather than waiting for the heap-critical post-mortem (which
 * cannot reach these retainers).
 */
export const createInMemoryEventBus = (): EventBus => {
  const handlers = new Set<(event: AppEvent) => void>();
  // One-shot latch: warn exactly once per bus so a sustained leak does not itself spam the console.
  let leakWarned = false;
  return {
    publish(event: AppEvent): void {
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch (err) {
          console.warn('[event-bus] handler threw:', err);
        }
      }
    },
    subscribe(handler: (event: AppEvent) => void): () => void {
      handlers.add(handler);
      if (!leakWarned && handlers.size > LISTENER_LEAK_THRESHOLD) {
        leakWarned = true;
        console.warn(
          `[event-bus] live subscriber count crossed ${LISTENER_LEAK_THRESHOLD} (now ${handlers.size}) — ` +
            'a chain-progress bridge is leaking its unsubscribe. Each leaked closure pins a branch ' +
            'runner + its forked ctx + trace ring; this is the long-session heap leak. Check that ' +
            'every bridgeRunnerToEventBus / captureDurableFold subscription is force-detached on wave teardown.'
        );
      }
      return () => {
        handlers.delete(handler);
      };
    },
  };
};
