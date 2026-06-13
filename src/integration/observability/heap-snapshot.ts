import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

/**
 * Best-effort heap-snapshot dump for post-mortem OOM diagnosis.
 *
 * The heap watchdog calls this on critical heap pressure. `v8.writeHeapSnapshot` streams the
 * snapshot directly to disk — it does NOT materialise the whole heap in RAM — so it can usually
 * complete inside the ~5% headroom left at the 0.95 critical ratio. It is best-effort by design:
 * everything is wrapped so a failure near-OOM returns a structured result instead of throwing and
 * compounding the crash. No retries — at 0.95 there is no headroom to spend on a second attempt.
 *
 * The resulting `.heapsnapshot` file opens in Chrome DevTools › Memory, where the dominant
 * retainer (the actual leak) names itself — which is the whole point: today's watchdog only
 * clears small-capped TUI buffers and frees nothing, so the OOM recurs undiagnosed.
 */
export type HeapSnapshotResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Build an fs-safe filename for a snapshot taken at `timestamp` (an ISO-ish string). Colons and
 * dots are replaced so the name is portable across filesystems.
 */
const snapshotFilename = (timestamp: string): string => `heap-${timestamp.replace(/[:.]/g, '-')}.heapsnapshot`;

/**
 * Write a V8 heap snapshot into `dir`, creating the directory if needed. Never throws: a failure
 * near-OOM must not crash the process further. Returns the absolute-or-resolved path on success.
 *
 * @param clock - injected timestamp source for the filename (tests). Defaults to `Date.now`-based ISO.
 * @public
 */
export const writeHeapSnapshotToDir = (dir: string, clock?: () => string): HeapSnapshotResult => {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const timestamp = clock?.() ?? new Date().toISOString();
    const fullPath = path.join(dir, snapshotFilename(timestamp));
    v8.writeHeapSnapshot(fullPath);
    return { ok: true, path: fullPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};
