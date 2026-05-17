import type { HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Specialized parser for one signal type. Owns its tag regex and any validation. Each parser
 * scans the full input and returns every match in document order. The registry concatenates
 * their outputs, then re-sorts by document position so the final stream preserves the order
 * the AI emitted.
 *
 * Why one-parser-per-tag (vs. a single regex with alternations):
 *   - Each tag's shape, body validation, and resulting signal payload live in one place.
 *   - Adding a new signal type is a localized change — write one new parser file, register it.
 *   - Tests target one parser at a time; failures point at the responsible module.
 */

export interface SignalMatch {
  /** Document offset where the match starts. Used to sort the merged stream. */
  readonly index: number;
  /** Number of characters consumed; future-proofs nested-tag de-duplication if needed. */
  readonly length: number;
  readonly signal: HarnessSignal;
}

export interface SignalParser {
  /** Stable tag name (used in error messages and debug output). */
  readonly tag: string;
  /**
   * Scan `text` for every occurrence of this parser's tag and return matches in document
   * order. Pure: no side effects, no mutation of the input.
   */
  parse(text: string, timestamp: IsoTimestamp): readonly SignalMatch[];
}
