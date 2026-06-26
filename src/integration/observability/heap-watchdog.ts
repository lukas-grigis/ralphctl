import * as v8 from 'node:v8';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { MemoryPressureEvent } from '@src/business/observability/events.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Heap-pressure watchdog. Samples V8's heap statistics on an interval and emits
 * a {@link MemoryPressureEvent} on every band transition so a TUI banner can
 * surface impending OOM long before the kernel sends SIGKILL.
 *
 * Bands (default thresholds):
 *   - `ok`        — ratio < 0.80
 *   - `warning`   — 0.80 ≤ ratio < 0.95 (operator still has time to abort)
 *   - `critical`  — ratio ≥ 0.95 (kernel SIGKILL is seconds away on a 4 GB heap)
 *
 * Events are emitted only on transitions, never on every poll, so subscribers
 * can treat the latest event as the current band without de-duping. Going down
 * past the warning floor emits one `'recovered'` event so the banner clears.
 *
 * `onWarning` is the early-relief hatch: fired once when severity transitions
 * INTO 'warning' (0.80). The TUI launcher passes a callback that sheds finished
 * session records — cheap and non-disruptive (no log-panel clear, no blocking
 * heap snapshot) — so GC can reclaim headroom BEFORE pressure reaches critical,
 * rather than waiting until the kernel is seconds from SIGKILL.
 *
 * `onCritical` is the operator-side post-mortem hatch. Its PRIMARY value is
 * capturing a heap snapshot for diagnosis: the TUI launcher uses it to dump a
 * `.heapsnapshot` so the next near-OOM names its own dominant retainer. It also
 * clears the harness/log/chain in-memory buffers, but those are small-capped (a
 * few MB) so that clear frees little — the snapshot is the real diagnostic, the
 * clear is just defensive. Fired exactly once per critical-band entry; re-arms
 * on the way down. Idempotent — if a user-supplied callback is missing or
 * throws the watchdog keeps polling.
 */

export interface HeapReading {
  readonly heapUsed: number;
  readonly heapLimit: number;
}

export interface HeapWatchdogDeps {
  readonly eventBus: EventBus;
  readonly clock?: () => IsoTimestamp;
  /** Polling interval ms. Default 10_000. Floored at 1000ms. */
  readonly intervalMs?: number;
  /** Ratio for the 'warning' threshold. Default 0.80. */
  readonly warningRatio?: number;
  /** Ratio for the 'critical' threshold. Default 0.95. */
  readonly criticalRatio?: number;
  /**
   * Optional early-relief hatch: invoked once when severity transitions INTO 'warning'.
   * The TUI launcher passes a callback that sheds finished session records — non-disruptive
   * (no log-panel clear, no blocking heap snapshot), so GC reclaims headroom before pressure
   * reaches critical. Idempotent — called at most once per warning-entry (re-arms on band change).
   */
  readonly onWarning?: () => void;
  /**
   * Optional post-mortem hatch: invoked once when severity transitions to 'critical'.
   * The TUI launcher passes a callback that captures a heap snapshot for diagnosis
   * (the actual value — it names the dominant retainer) and also clears the
   * harness/log/chainEvents buffers (defensive; those buffers are small-capped so the
   * clear frees little). Idempotent — the watchdog calls it at most once per
   * critical-entry (re-arms after going back below critical).
   */
  readonly onCritical?: () => void;
  /** Inject for tests. Real impl uses `v8.getHeapStatistics()`. */
  readonly readHeap?: () => HeapReading;
}

export interface HeapWatchdog {
  /** Stop polling. Idempotent. */
  stop(): void;
}

const MIN_INTERVAL_MS = 1000;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_WARNING_RATIO = 0.8;
const DEFAULT_CRITICAL_RATIO = 0.95;

type Band = 'ok' | 'warning' | 'critical';

const defaultReadHeap = (): HeapReading => {
  const stats = v8.getHeapStatistics();
  return { heapUsed: stats.used_heap_size, heapLimit: stats.heap_size_limit };
};

const classify = (ratio: number, warning: number, critical: number): Band => {
  if (ratio >= critical) return 'critical';
  if (ratio >= warning) return 'warning';
  return 'ok';
};

export const startHeapWatchdog = (deps: HeapWatchdogDeps): HeapWatchdog => {
  const intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  const warning = deps.warningRatio ?? DEFAULT_WARNING_RATIO;
  const critical = deps.criticalRatio ?? DEFAULT_CRITICAL_RATIO;
  const clock = deps.clock ?? IsoTimestamp.now;
  const readHeap = deps.readHeap ?? defaultReadHeap;

  let stopped = false;
  let previousBand: Band = 'ok';

  const emit = (severity: MemoryPressureEvent['severity'], reading: HeapReading, ratio: number): void => {
    deps.eventBus.publish({
      type: 'memory-pressure',
      severity,
      ratio,
      heapUsed: reading.heapUsed,
      heapLimit: reading.heapLimit,
      at: clock(),
    });
  };

  const sample = (): void => {
    if (stopped) return;
    const reading = readHeap();
    const ratio = reading.heapLimit > 0 ? reading.heapUsed / reading.heapLimit : 0;
    const band = classify(ratio, warning, critical);
    if (band === previousBand) return;

    if (band === 'warning') {
      emit('warning', reading, ratio);
      try {
        deps.onWarning?.();
      } catch (err) {
        console.warn('[heap-watchdog] onWarning threw:', err);
      }
    } else if (band === 'critical') {
      emit('critical', reading, ratio);
      try {
        deps.onCritical?.();
      } catch (err) {
        console.warn('[heap-watchdog] onCritical threw:', err);
      }
    } else {
      // band === 'ok' — came down from warning or critical.
      emit('recovered', reading, ratio);
    }
    previousBand = band;
  };

  const handle = setInterval(sample, intervalMs);
  // Don't keep the event loop alive just for memory polling — if every other
  // handle is gone the process should exit cleanly.
  handle.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(handle);
    },
  };
};
