import type { HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { runSignalParsers } from '@tests/helpers/legacy-signal-parsers/_engine/registry.ts';

/**
 * Extract `HarnessSignal[]` from raw AI output. Signals are emitted by the AI as XML-style
 * tags inside its markdown body; the parser scans in document order and produces a typed
 * stream the application layer feeds into a `HarnessSignalSink`.
 *
 * Implementation: composed of single-responsibility parsers under `signal-parsers/`. Adding
 * a new tag is a localized change — write one parser file, register it in
 * `signal-parsers/registry.ts`. The aggregator merges every parser's matches and re-sorts
 * by document position.
 *
 * The single `timestamp` is applied to every emitted signal. Callers that need per-signal
 * timestamps (because the AI streamed output across multiple ticks) re-invoke the parser per
 * stream chunk with a fresh `now()`.
 */
export const parseHarnessSignals = (text: string, timestamp: IsoTimestamp): readonly HarnessSignal[] =>
  runSignalParsers(text, timestamp);

export { runSignalParsers, DEFAULT_SIGNAL_PARSERS } from '@tests/helpers/legacy-signal-parsers/_engine/registry.ts';
export type { SignalMatch, SignalParser } from '@tests/helpers/legacy-signal-parsers/_engine/parser-types.ts';
