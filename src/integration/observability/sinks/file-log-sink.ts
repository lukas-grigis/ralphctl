import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { AppEvent } from '@src/business/observability/events.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
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
 * `emit` is fire-and-forget (sync). Failures are silenced — a log sink must NEVER take down
 * the chain. `flush()` returns once the queue drains, used in tests + shutdown.
 */

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
      } catch {
        // Best-effort. A log sink must never take down the chain.
      }
    }
    draining = undefined;
  };

  const onEvent = (event: AppEvent): void => {
    if (stopped) return;
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
