import type { AppendFile } from '@src/business/io/append-file.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Port-shaped contracts for the chain-log file sink. Lives in `_engine/` so consumers
 * (wire bootstrap, tests) depend on a port type, not the concrete `sinks/file-log-sink.ts`
 * factory.
 *
 * The runtime semantics (chain-run brackets, NDJSON line format, drop-newest back-pressure,
 * one-shot degradation marker) live in {@link startFileLogSink}; see the doc block there.
 */
export interface FileLogSinkDeps {
  /** Absolute path to the NDJSON file. Parent directory is created on first write. */
  readonly file: AbsolutePath;
  /** Event bus to subscribe to. The sink installs its own handler. */
  readonly bus: EventBus;
  /** Append adapter — the sink does not call `fs.appendFile` directly. */
  readonly appendFile: AppendFile;
}

export interface FileLogSink {
  /** Unsubscribe from the bus. Idempotent. Pending writes still drain. */
  stop(): void;
  /** Resolves once every queued event has been written. Errors are swallowed. */
  flush(): Promise<void>;
}
