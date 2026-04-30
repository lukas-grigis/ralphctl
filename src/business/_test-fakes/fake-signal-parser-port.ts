/**
 * `FakeSignalParserPort` — non-IO fake of {@link SignalParserPort} for use
 * case unit tests.
 *
 * Returns the next scripted signal list per `parse()` invocation, in FIFO
 * order. When the script is exhausted, returns `[]`. Captures every raw
 * input and the `now` opt for assertion convenience.
 */
import type { HarnessSignal } from '../../domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '../../domain/values/iso-timestamp.ts';
import type { SignalParserPort } from '../ports/signal-parser-port.ts';

export interface CapturedParse {
  readonly rawOutput: string;
  readonly now?: IsoTimestamp;
}

export interface FakeSignalParserOptions {
  /** Sequence of signal lists to return — one per `parse()` call. */
  readonly results?: readonly (readonly HarnessSignal[])[];
}

export class FakeSignalParserPort implements SignalParserPort {
  readonly captured: CapturedParse[] = [];
  private readonly results: (readonly HarnessSignal[])[];

  constructor(opts?: FakeSignalParserOptions) {
    this.results = opts?.results === undefined ? [] : opts.results.map((r) => [...r]);
  }

  parse(rawOutput: string, opts?: { readonly now: IsoTimestamp }): readonly HarnessSignal[] {
    this.captured.push({
      rawOutput,
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    });
    const next = this.results.shift();
    return next ?? [];
  }
}
