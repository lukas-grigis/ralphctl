/**
 * Shared types for the Copilot JSONL parser. The concrete `createCopilotStreamParser`
 * factory lives in `copilot/parse-stream.ts`; the port-shaped `CopilotStreamParser` interface
 * and the input/output data shapes live here in `_engine/` so siblings depending on the
 * parser (e.g. `copilot/headless.ts`) consume a port, not an implementation detail.
 *
 * See `copilot/parse-stream.ts` for runtime semantics + the recognised event shapes.
 */

/**
 * Token counts the Copilot CLI may report on a JSON meta line. Every field is optional —
 * Copilot's `--output-format=json` documents the `session_id` / `model` keys but does NOT
 * commit to surfacing per-spawn usage. The parser extracts whatever lands in the meta payload
 * and the adapter forwards what is present.
 */
export interface CopilotUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CopilotStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object when the line was a valid JSON record; absent for plain lines. */
  readonly json?: Record<string, unknown>;
  /** Convenience: `json.session_id` (or `json.sessionId`) when present, for the adapter to log. */
  readonly sessionId?: string;
  /** Convenience: `json.model` when present on the meta line. */
  readonly model?: string;
  /** Convenience: token counters pulled from any `usage` sub-object on the meta line. */
  readonly usage?: CopilotUsage;
  /**
   * Assistant body text extracted from a known JSON event shape.
   * Absent for metadata-only records.
   */
  readonly bodyText?: string;
}

export interface CopilotStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete line. */
  feed(chunk: string, onLine: (line: CopilotStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child exit). */
  flush(onLine: (line: CopilotStreamLine) => void): void;
}
