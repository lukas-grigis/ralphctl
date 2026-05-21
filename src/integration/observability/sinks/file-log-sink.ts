import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Append-only JSONL log of every `AppEvent` published on the bus for the lifetime of one
 * implement (or other long-running) chain. Writes to `<sprintDir>/chain.log`.
 *
 * Why a separate persistent log: in-memory TUI buffers vanish with the process. When the
 * chain dies overnight — Ctrl-C? OOM? host sleep? the operator's host crashed? — the
 * orphan running attempt on disk tells you the chain stopped but not WHY. A persisted log
 * tee'd from the event bus survives the crash and answers that question without re-running
 * the sprint.
 *
 * Format: one JSON object per line. Each line carries the event verbatim (type-tagged
 * AppEvent) so a downstream tool (jq / a future `ralphctl doctor`) can filter cheaply. No
 * frontmatter, no rotation — append-only; the operator removes the file when they want to
 * reset.
 *
 * Concurrency: writes go through a serial drain queue. `fs.appendFile` is atomic per-call on
 * POSIX for chunks ≤ PIPE_BUF (4KB on Linux, 512B on macOS guaranteed) but each event line
 * is unbounded (meta payloads can be large), so we serialize to avoid interleaved bytes. The
 * sink itself is single-process; cross-process locking is not needed because `chain.log` is
 * sprint-scoped and the harness's repo lock prevents concurrent chains on the same sprint.
 *
 * Back-pressure: the in-memory queue is capped at {@link MAX_QUEUE}. When the cap is hit the
 * sink drops the inbound event (drop-newest policy — newest events are the cheapest to lose
 * because the older queued ones carry context the operator will need to reconstruct what
 * happened). The first time either back-pressure OR an actual write failure occurs the sink
 * publishes a single `chain-log-degraded` event onto the bus, then stays silent for the rest
 * of its lifetime (one-shot contract — the banner only needs to latch once; spamming the bus
 * with every subsequent drop or failure would compete with real signal for screen real estate
 * and re-enter the sink's own queue).
 *
 * `emit` is fire-and-forget (sync). Failures are silenced at the write layer — a log sink
 * must NEVER take down the chain. `flush()` returns once the queue drains, used in tests +
 * shutdown.
 */

/**
 * Maximum events the in-memory drain queue can hold before the sink starts dropping the
 * newest inbound events. 10_000 is enough headroom that a transient disk-write stall (e.g.
 * spinning-disk fsync spike, fuse-mount slowdown) won't trip the cap; if the gap is sustained
 * the operator wants to know the log is no longer complete rather than silently accruing
 * unbounded RAM.
 */
const MAX_QUEUE = 10_000;

const isMissingPathError = (err: unknown): boolean => {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { readonly code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export interface FileLogSinkDeps {
  /** Absolute path to the JSONL file. Parent directory is created on first write. */
  readonly file: AbsolutePath;
  /** Event bus to subscribe to. The sink installs its own handler. */
  readonly bus: EventBus;
}

export interface FileLogSink {
  /** Unsubscribe from the bus. Idempotent. Pending writes still drain. */
  stop(): void;
  /** Resolves once every queued event has been written. Errors are swallowed. */
  flush(): Promise<void>;
}

export const startFileLogSink = (deps: FileLogSinkDeps): FileLogSink => {
  const queue: AppEvent[] = [];
  let draining: Promise<void> | undefined;
  let dirEnsured = false;
  let stopped = false;
  // Latches once the sink has published `chain-log-degraded` for the first time. Subsequent
  // queue overflows and write failures are silenced — the banner is already up; re-emitting
  // would spam the bus and (worse) re-enter the sink's own queue.
  let degraded = false;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) continue;
      try {
        if (!dirEnsured) {
          await fs.mkdir(dirname(String(deps.file)), { recursive: true });
          dirEnsured = true;
        }
        await fs.appendFile(String(deps.file), `${JSON.stringify(next)}\n`, 'utf8');
      } catch (err) {
        // Best-effort write — never take down the chain. But fire the one-shot degradation
        // marker so the operator knows the on-disk trace is incomplete.
        // If the parent directory disappeared after our initial mkdir (tmpfs cleanup, fuse
        // remount, operator `rm -rf` of the sprint dir), `dirEnsured` is stale — drop it so
        // the next iteration re-creates the directory before retrying the append.
        if (isMissingPathError(err)) dirEnsured = false;
        if (!degraded) {
          degraded = true;
          deps.bus.publish({
            type: 'chain-log-degraded',
            reason: 'write-failed',
            meta: { error: err instanceof Error ? err.message : String(err) },
            at: IsoTimestamp.now(),
          });
        }
      }
    }
    draining = undefined;
  };

  const onEvent = (event: AppEvent): void => {
    if (stopped) return;
    // Re-entrancy guard: never enqueue our own degradation marker. Without this the first
    // write failure would publish the marker, which would synchronously land back here and
    // get appended — round-tripping the event we are trying to surface and (worse) putting it
    // on a queue that may itself be in trouble.
    if (event.type === 'chain-log-degraded') return;
    if (queue.length >= MAX_QUEUE) {
      // Drop-newest: keep the older, context-rich queued events; lose the most recent inbound
      // one. Newest events are the cheapest to drop because the operator already saw their
      // immediate effects on the TUI; the older queued ones are what they need on disk to
      // reconstruct what led to the stall.
      if (!degraded) {
        degraded = true;
        deps.bus.publish({
          type: 'chain-log-degraded',
          reason: 'queue-full',
          at: IsoTimestamp.now(),
        });
      }
      return;
    }
    queue.push(event);
    if (draining === undefined) draining = drain();
  };

  const unsubscribe = deps.bus.subscribe(onEvent);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
    async flush(): Promise<void> {
      if (draining !== undefined) await draining;
    },
  };
};
