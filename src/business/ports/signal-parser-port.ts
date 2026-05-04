/**
 * `SignalParserPort` — extracts a list of `HarnessSignal`s from raw AI
 * stdout. Pure (no I/O, no side effects) and total (never throws).
 *
 * The `now` injection point lets tests pin the timestamp deterministically;
 * adapters default to `IsoTimestamp.now()` when the option is omitted.
 *
 * Diagnostics — silently-dropped malformed AI output (truncated tag spans,
 * dimension lines that don't match the score format) is observable via
 * {@link parseWithDiagnostics}. The diagnostic stream is a sibling to
 * `HarnessSignal`, not a variant — diagnostics describe parse failures, not
 * harness events.
 */
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

/**
 * Per-issue observability record emitted by {@link SignalParserPort.parseWithDiagnostics}.
 *
 * Discriminated union — narrow on `kind` for handler-specific reporting:
 *  - `unclosed-tag` — an opening tag (`<progress>`, `<note>`, …) was never
 *    matched by a closing tag in the same document. The parser silently
 *    drops the partial signal; this diagnostic surfaces it. `index` is the
 *    byte offset of the unmatched opening tag.
 *  - `malformed-dimension` — a line begins with a bolded label
 *    (`**Name**…`) so it *looks like* an attempted dimension declaration,
 *    but does not match the strict `**Name** (score 1-5): N — finding`
 *    regex. Indicates evaluator prompt drift. `index` is the byte offset of
 *    the bolded label.
 *
 * `sample` is a short slice of the surrounding raw text (clipped to ~80
 * chars) so log viewers and dashboards can render context without dumping
 * the full AI output.
 */
export type SignalParseDiagnostic =
  | {
      readonly kind: 'unclosed-tag';
      readonly tag: string;
      readonly sample: string;
      readonly index: number;
    }
  | {
      readonly kind: 'malformed-dimension';
      readonly sample: string;
      readonly index: number;
    };

/** Composite return shape of {@link SignalParserPort.parseWithDiagnostics}. */
export interface ParseWithDiagnosticsResult {
  readonly signals: readonly HarnessSignal[];
  readonly diagnostics: readonly SignalParseDiagnostic[];
}

export interface SignalParserPort {
  /**
   * Parse raw AI stdout into harness signals in emission order.
   *
   * Behaviour:
   *  - Empty / no-match input returns `[]`.
   *  - Malformed signals are skipped silently. Callers that need visibility
   *    into the silently-dropped tail use {@link parseWithDiagnostics}.
   *  - Signals are stamped with `opts.now` (or the adapter's clock when
   *    omitted) so callers can pin time in tests.
   *  - Never throws.
   */
  parse(rawOutput: string, opts?: { readonly now: IsoTimestamp }): readonly HarnessSignal[];

  /**
   * Parse + report parse diagnostics for malformed AI output. Returns
   * `{ signals, diagnostics }`; `signals` is identical to {@link parse}'s
   * return value for the same input. Callers are expected to log / surface
   * non-empty `diagnostics` arrays — the parser itself never logs.
   *
   * Same behavioural contract as {@link parse}: pure, total, never throws.
   */
  parseWithDiagnostics(rawOutput: string, opts?: { readonly now: IsoTimestamp }): ParseWithDiagnosticsResult;
}
