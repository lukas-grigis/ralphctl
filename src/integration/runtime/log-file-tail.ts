/**
 * Tail a log file from disk: replay everything written so far, then watch
 * for appended lines and forward them as they arrive.
 *
 * Used by `ralphctl sprint attach` so an Ink view in one process can show
 * live output from a daemon writing to the same log file in another process.
 *
 * Implementation: a single file descriptor positioned at byte offset N. On
 * every `fs.watch` change event, read from N to the current EOF, split into
 * lines, advance N, and forward complete lines. Partial trailing lines
 * (no terminating newline) are buffered until the next event completes them.
 */

import { open, type FileHandle } from 'node:fs/promises';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';

export type TailListener = (line: string) => void;

export interface TailHandle {
  /** Stop watching and close the file. Idempotent. */
  close(): Promise<void>;
}

export interface TailOptions {
  readonly path: string;
  /** Called once for each complete line read (no trailing newline). */
  readonly onLine: TailListener;
  /** Called when an unrecoverable read error occurs. */
  readonly onError?: (err: Error) => void;
  /**
   * Replay the entire current file contents on attach before subscribing
   * to new changes. Defaults to true so the user sees historical context.
   */
  readonly replayHistory?: boolean;
}

/**
 * Open the file, replay (optional), then start an `fs.watch` for appended
 * content. Returns a handle exposing `close()` so callers can clean up.
 */
export async function tailLogFile(options: TailOptions): Promise<TailHandle> {
  const { path, onLine, onError, replayHistory = true } = options;
  let handle: FileHandle | null;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    // Missing file is non-fatal — the daemon may not have written yet.
    // Surface to the caller via onError so they can decide whether to retry.
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    handle = null;
  }

  let position = 0;
  let pendingLine = '';
  let watcher: FSWatcher | null = null;
  let closed = false;
  let reading = false;

  async function readPending(): Promise<void> {
    if (closed || handle === null || reading) return;
    reading = true;
    try {
      const stat = await handle.stat();
      if (stat.size < position) {
        // Truncation or rotation — restart from the new beginning.
        position = 0;
        pendingLine = '';
      }
      // The `closed` flag may flip asynchronously between awaits while
      // the parent close()s the handle — the lint analyser can't see that.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      while (!closed && position < stat.size) {
        const remaining = stat.size - position;
        const length = Math.min(64 * 1024, remaining);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        const chunk = buf.subarray(0, bytesRead).toString('utf-8');
        const combined = pendingLine + chunk;
        const lines = combined.split('\n');
        pendingLine = lines.pop() ?? '';
        for (const line of lines) {
          onLine(line);
        }
      }
    } catch (err) {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      reading = false;
    }
  }

  if (handle !== null && replayHistory) {
    await readPending();
  } else if (handle !== null) {
    const stat = await handle.stat();
    position = stat.size;
  }

  if (handle !== null) {
    try {
      const w = watch(path, { persistent: false }, () => {
        void readPending();
      });
      w.on('error', (err) => {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      });
      watcher = w;
    } catch (err) {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // ignore
        }
        watcher = null;
      }
      if (handle) {
        try {
          await handle.close();
        } catch {
          // ignore
        }
        handle = null;
      }
    },
  };
}
