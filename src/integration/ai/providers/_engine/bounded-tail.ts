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
