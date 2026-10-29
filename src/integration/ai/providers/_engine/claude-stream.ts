/**
 * Port-shaped types for the Claude stream-json parser; the factory lives in `claude/parse-stream.ts`.
 * Usage key names match `TokenUsageEvent`, so the adapter spreads them straight into the event.
 */

/** Cumulative spawn totals from the final `result` event. Claude omits a zero counter rather than sending `0`. */
export interface ClaudeUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
}

/**
 * Per-turn counts from the LATEST `assistant` event's `message.usage`. Their sum is the current
 * context-window occupancy, which the cumulative {@link ClaudeUsage} cannot give.
 */
export interface ClaudeLiveUsage {
  readonly liveInputTokens?: number;
  readonly liveCacheReadTokens?: number;
  readonly liveCacheCreationTokens?: number;
}

export interface ClaudeEnvelope {
  /** `.result` from the `result` event, or `''` if none arrived. */
  readonly body: string;
  /** Earliest `session_id` seen on any event. */
  readonly sessionId: string | undefined;
  /** Model name from the `system` init event. */
  readonly model: string | undefined;
  readonly usage: ClaudeUsage;
  /** `{}` until an assistant turn carries usage. */
  readonly liveUsage: ClaudeLiveUsage;
}

export interface ClaudeStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object; absent for non-JSON noise. */
  readonly json?: Record<string, unknown>;
}

export interface ClaudeStreamParser {
  /** Calls `onLine` once per complete newline-terminated line. */
  feed(chunk: string, onLine: (line: ClaudeStreamLine) => void): void;
  /** Emits a trailing partial line, if any (called once on child close). */
  flush(onLine: (line: ClaudeStreamLine) => void): void;
  /** Fold one line into the envelope; the adapter calls it for every line `feed`/`flush` yields. */
  ingest(line: ClaudeStreamLine): void;
  snapshot(): ClaudeEnvelope;
}
