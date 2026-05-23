import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Sink } from '@src/business/observability/sink.ts';

/**
 * Output port for the structured harness-signal stream emitted by AI sessions under the
 * audit-[09] contract. Producers (AI-spawning leaves) validate `signals.json` via
 * `validateSignalsFile` then `.emit(...)` each validated signal here in parallel with the
 * typed `ai-signal` event-bus publish. The sink path stays alive until every legacy TUI
 * consumer migrates to the bus's typed subscription.
 *
 * Concrete implementations under `integration/observability/sinks/` (in-memory, broadcast)
 * back this port and the matching `LogSink` from one shared `Sink<T>` primitive.
 */
export type HarnessSignalSink = Sink<HarnessSignal>;
