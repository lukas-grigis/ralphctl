/**
 * Rolling tail accumulator — keeps at most the last `capBytes` characters of an unbounded stream,
 * so a chatty hour-long child cannot grow an in-memory string for the whole spawn. The consumers
 * only regex-match or inspect the TAIL, so dropping older bytes loses nothing they use.
 */

/** Child stderr tail the exit classifier scans for rate-limit / model-unavailable markers. */
export const STDERR_TAIL_CAP = 16_384;

/** Stdout tail fed to the rate-limit classifier. */
export const RATE_LIMIT_SCAN_TAIL_CAP = 8192;

/** Forensic body mirrored to `body.txt` — the window an operator inspects after an empty proposal. */
export const FORENSIC_BODY_TAIL_CAP = 262_144;

export interface BoundedTail {
  append(chunk: string): void;
  value(): string;
}

export const createBoundedTail = (capBytes: number): BoundedTail => {
  let buf = '';
  return {
    append(chunk) {
      buf += chunk;
      if (buf.length > capBytes) buf = buf.slice(-capBytes);
    },
    value: () => buf,
  };
};
