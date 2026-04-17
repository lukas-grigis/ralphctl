/**
 * Signal parser port — interface for parsing AI agent output into structured signals.
 *
 * The harness uses this port to extract typed HarnessSignal objects from raw AI output.
 * Parser is pure (no side effects) and returns an array of parsed signals.
 */

import type { HarnessSignal } from '@src/domain/signals.ts';

/**
 * Port interface for signal parsing.
 * Extracts all HarnessSignal objects from raw AI agent output.
 */
export interface SignalParserPort {
  /**
   * Parse all signals from raw AI agent output.
   *
   * @param output Raw output from AI agent (stdout)
   * @returns Array of parsed signals in extraction order (may be empty if no signals found)
   *
   * Behavior:
   * - Returns empty array if no signals found (doesn't throw)
   * - Handles batched/buffered output (multiple signals in single chunk)
   * - Gracefully skips malformed signals (logs warning, continues parsing)
   * - Returns signals in the order they appear in output
   * - Signals are timestamped by the parser (uses current time)
   *
   * No side effects: function is pure.
   */
  parseSignals(output: string): HarnessSignal[];
}
