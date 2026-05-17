import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Sink } from '@src/business/observability/sink.ts';

/**
 * Output port for the structured harness-signal stream emitted by AI sessions. The provider
 * adapter parses raw output (stdout / SDK events) into `HarnessSignal[]` via
 * `parseHarnessSignals` and forwards each one to whichever sink is wired in.
 *
 * Adapters under `integration/observability/sinks/` (in-memory, broadcast, file) work for any
 * `Sink<T>`, so the same sink primitives back both `HarnessSignalSink` and `LogSink`.
 */
export type HarnessSignalSink = Sink<HarnessSignal>;
