/**
 * Shared types for the Claude stream-json parser. The concrete `createClaudeStreamParser`
 * factory lives in `claude/parse-stream.ts`; the port-shaped `ClaudeStreamParser` interface
 * and the input/output data shapes live here in `_engine/` so siblings depending on the
 * parser (e.g. `claude/headless.ts`) consume a port, not an implementation detail.
 *
 * See `claude/parse-stream.ts` for runtime semantics, stream shape examples, and the rationale
 * behind first-id-wins / last-write-wins on usage.
 */

/**
 * Per-spawn token counts pulled from the final `{type:"result"}` event's `usage` object.
 * Every field is optional because cache reads / creations are zero on a stateless spawn and
 * Claude omits the field rather than emitting `0`. Cumulative — already the spawn total at
 * the moment Claude emits the result event, no in-process aggregation needed.
 */
export interface ClaudeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

export interface ClaudeEnvelope {
  /** Assistant body — `.result` from the `{type:"result"}` event, or `''` if none arrived. */
  readonly body: string;
  /** Earliest `session_id` seen on any event (init wins under normal operation). */
  readonly sessionId: string | undefined;
  /** Model name from the `system` init event, when present. */
  readonly model: string | undefined;
  /** Token counts from the final `result` event's `usage` object, when present. */
  readonly usage: ClaudeUsage;
}

export interface ClaudeStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object when the line was a valid JSON record; absent for non-JSON noise. */
  readonly json?: Record<string, unknown>;
}

export interface ClaudeStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete newline-terminated line. */
  feed(chunk: string, onLine: (line: ClaudeStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child close). */
  flush(onLine: (line: ClaudeStreamLine) => void): void;
  /**
   * Accumulate state from a parsed line. Called by the adapter for every line `feed`/`flush`
   * yields, so the running `{ body, sessionId, model }` snapshot stays internal to the parser
   * and there is one canonical reduction over the stream.
   */
  ingest(line: ClaudeStreamLine): void;
  /** Snapshot the accumulated envelope (body / sessionId / model so far). */
  snapshot(): ClaudeEnvelope;
}
