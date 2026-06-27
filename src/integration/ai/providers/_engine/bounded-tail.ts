/**
 * Rolling tail accumulator — retains at most the last `capBytes` characters of an otherwise
 * unbounded stream.
 *
 * The headless provider adapters (`claude/`, `copilot/`, `codex/`) feed child **stderr** through
 * one of these so a verbose, looping, or hung child cannot grow an in-memory string for the whole
 * spawn lifetime (an hour-long implement run with a chatty stderr would otherwise accumulate
 * megabytes that live until the spawn frame is discarded). The only consumer is the spawn-exit
 * classifier (`classify-spawn-exit.ts`), which regex-matches the TAIL for rate-limit /
 * model-unavailable markers — so dropping older bytes is information-preserving for that purpose.
 *
 * The cap is applied after each append (mirroring the `createCoalescedBuffer` push idiom): a single
 * append briefly holds `prev + chunk` before trimming, but stream chunks are pipe-sized (≤ ~64 KiB),
 * so the transient overshoot is bounded and immediately reclaimed.
 */

/**
 * Default retained-tail size for child stderr across the headless adapters. The classifier only
 * inspects the tail for rate-limit / model-unavailable markers, so 16 KiB is ample context while
 * pinning the per-spawn stderr footprint regardless of how chatty the child is.
 */
export const STDERR_TAIL_CAP = 16_384;

/**
 * Retained-tail size for the assistant/agent STDOUT body fed to the rate-limit classifier. The
 * classifier scans only the tail for rate-limit / model-unavailable markers, so this bounds the
 * per-spawn stdout scan window. Unified here from the byte-identical local `RATE_LIMIT_TAIL_CAP`
 * (copilot) / `AGENT_TAIL_CAP` (codex) constants so the siblings can't drift.
 */
export const RATE_LIMIT_SCAN_TAIL_CAP = 8192;

/**
 * Hard ceiling on the in-flight NDJSON line-parse accumulator in the stdout stream parsers
 * (`claude/parse-stream.ts`, `copilot/parse-stream.ts`). Those parsers grow `buffer += chunk`
 * until a newline terminates the current line; a single record embedding a large file-read or
 * bash tool result can inflate one line to tens of MB before the newline clears it, which is an
 * OOM-class accumulation (same root cause as the TUI render-path leak). When the unterminated
 * line crosses this cap the parser drops the OLDEST bytes back to the cap and keeps draining —
 * 512 KiB leaves ample room for any legitimate JSONL record while pinning the worst-case
 * per-line footprint regardless of how large a tool result the child streams.
 */
export const STDOUT_LINE_PARSE_CAP = 524_288;

/**
 * Retained-tail size for the Copilot forensic body mirror (`body.txt` when `session.bodyFile` is
 * set). The adapter formerly retained EVERY stdout line for the whole spawn in an unbounded
 * `events[]` array — an OOM-class accumulation on a multi-hour, chatty session. A bounded tail
 * caps that footprint while keeping the most recent ~256 KiB, which is the diagnostic window an
 * operator actually inspects when a proposal comes back empty (older lines rarely matter for that
 * post-mortem). Larger than {@link RATE_LIMIT_SCAN_TAIL_CAP} because forensic capture wants more
 * context than the narrow rate-limit marker scan.
 */
export const FORENSIC_BODY_TAIL_CAP = 262_144;

/** @public */
export interface BoundedTail {
  /** Append a chunk, trimming the retained window back to the cap when it overflows. */
  append(chunk: string): void;
  /** The current retained tail (at most `capBytes` characters). */
  value(): string;
}

/** @public */
export const createBoundedTail = (capBytes: number): BoundedTail => {
  let buf = '';
  return {
    append(chunk: string): void {
      buf += chunk;
      if (buf.length > capBytes) buf = buf.slice(-capBytes);
    },
    value(): string {
      return buf;
    },
  };
};
