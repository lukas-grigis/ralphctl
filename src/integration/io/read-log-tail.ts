import { promises as fs } from 'node:fs';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { LogTailReader } from '@src/business/io/log-tail-reader.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';

/**
 * Default cap on the number of bytes the adapter reads from the tail of a log file. 4 KiB
 * is enough to render the last "pnpm install" summary block or the final stack frame of a
 * failing verify script in a TUI popover without streaming an unbounded body. Callers
 * passing a smaller `maxBytes` get the cap they ask for; passing a larger value is honoured
 * but discouraged for live-render paths.
 */
export const DEFAULT_LOG_TAIL_BYTES = 4096;

/**
 * File-backed {@link LogTailReader}. Opens the file, seeks to `size - min(maxBytes, size)`,
 * reads to EOF, and decodes UTF-8. A missing file resolves to `undefined`; any other I/O
 * error logs nothing here and also resolves to `undefined` (the port is intentionally
 * silent — display surfaces fall back to "(no log)" instead of crashing).
 *
 * Slicing in the middle of a multi-byte UTF-8 character is harmless: Node's default
 * decoder substitutes U+FFFD for the partial bytes, which is visually obvious in the
 * popover.
 */
export const createFsLogTailReader = (): LogTailReader => {
  return async (path: AbsolutePath, maxBytes: number = DEFAULT_LOG_TAIL_BYTES): Promise<string | undefined> => {
    const cap = Math.max(0, Math.floor(maxBytes));
    if (cap === 0) return '';
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(String(path), 'r');
      const stat = await handle.stat();
      const size = stat.size;
      if (size <= 0) return '';
      const readLen = Math.min(size, cap);
      const buf = Buffer.alloc(readLen);
      await handle.read(buf, 0, readLen, size - readLen);
      return buf.toString('utf8');
    } catch (cause) {
      if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) return undefined;
      return undefined;
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => {
          // best-effort cleanup
        });
      }
    }
  };
};
