/**
 * `FakeSignalParserPort` — non-IO fake of {@link SignalParserPort} for use
 * case unit tests.
 *
 * Returns the next scripted signal list per `parse()` invocation, in FIFO
 * order. When the script is exhausted, returns `[]`. Captures every raw
 * input and the `now` opt for assertion convenience.
 *
 * Diagnostics — `parseWithDiagnostics()` returns the same scripted signal
 * list paired with the matching scripted diagnostics list (defaults to
 * `[]`). Tests opting into diagnostic-emission coverage script both
 * arrays in lockstep; tests that don't care leave `diagnostics` unset.
 */
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type {
  ParseWithDiagnosticsResult,
  SignalParseDiagnostic,
  SignalParserPort,
} from '@src/business/ports/signal-parser-port.ts';

export interface CapturedParse {
  readonly rawOutput: string;
  readonly now?: IsoTimestamp;
}

export interface FakeSignalParserOptions {
  /** Sequence of signal lists to return — one per `parse()` call. */
  readonly results?: readonly (readonly HarnessSignal[])[];
  /**
   * Sequence of diagnostic lists to return — one per `parseWithDiagnostics()`
   * call. Aligned by index with `results`. Missing entries default to `[]`.
   */
  readonly diagnostics?: readonly (readonly SignalParseDiagnostic[])[];
}

export class FakeSignalParserPort implements SignalParserPort {
  readonly captured: CapturedParse[] = [];
  private readonly results: (readonly HarnessSignal[])[];
  private readonly diagnostics: (readonly SignalParseDiagnostic[])[];

  constructor(opts?: FakeSignalParserOptions) {
    this.results = opts?.results === undefined ? [] : opts.results.map((r) => [...r]);
    this.diagnostics = opts?.diagnostics === undefined ? [] : opts.diagnostics.map((d) => [...d]);
  }

  parse(rawOutput: string, opts?: { readonly now: IsoTimestamp }): readonly HarnessSignal[] {
    return this.parseWithDiagnostics(rawOutput, opts).signals;
  }

  parseWithDiagnostics(rawOutput: string, opts?: { readonly now: IsoTimestamp }): ParseWithDiagnosticsResult {
    this.captured.push({
      rawOutput,
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    });
    const signals = this.results.shift() ?? [];
    const diagnostics = this.diagnostics.shift() ?? [];
    return { signals, diagnostics };
  }
}
