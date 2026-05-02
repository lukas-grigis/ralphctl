/**
 * `SignalParserPort` — extracts a list of `HarnessSignal`s from raw AI
 * stdout. Pure (no I/O, no side effects) and total (never throws).
 *
 * The `now` injection point lets tests pin the timestamp deterministically;
 * adapters default to `IsoTimestamp.now()` when the option is omitted.
 */
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

export interface SignalParserPort {
  /**
   * Parse raw AI stdout into harness signals in emission order.
   *
   * Behaviour:
   *  - Empty / no-match input returns `[]`.
   *  - Malformed signals are skipped (the adapter logs a warning).
   *  - Signals are stamped with `opts.now` (or the adapter's clock when
   *    omitted) so callers can pin time in tests.
   *  - Never throws.
   */
  parse(rawOutput: string, opts?: { readonly now: IsoTimestamp }): readonly HarnessSignal[];
}
