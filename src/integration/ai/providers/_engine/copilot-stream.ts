/** Port-shaped types for the Copilot JSONL parser; the factory lives in `copilot/parse-stream.ts`. */

/** Copilot does not commit to reporting usage; only what is present is forwarded. */
export interface CopilotUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CopilotStreamLine {
  /** Raw line text (no trailing newline). */
  readonly raw: string;
  /** Parsed JSON object; absent for plain lines. */
  readonly json?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly model?: string;
  readonly usage?: CopilotUsage;
  /** Assistant text from a known event shape; absent for metadata-only records. */
  readonly bodyText?: string;
}

export interface CopilotStreamParser {
  /** Feed a chunk of stdout. Calls `onLine` once per complete line. */
  feed(chunk: string, onLine: (line: CopilotStreamLine) => void): void;
  /** Flush a trailing partial line if any (called once on child exit). */
  flush(onLine: (line: CopilotStreamLine) => void): void;
}
