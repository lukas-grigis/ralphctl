/**
 * `JsonlFileWriter` — per-session JSONL writer for high-leverage debug logs.
 *
 * Append-only writes to `<logsDir>/<session-id>.jsonl`, one JSON object
 * per line. The composition root decides which sink fans entries here in
 * task 15 — this module only owns the file mechanics.
 *
 * Writes are serialised via an internal promise chain so concurrent
 * `write()` calls don't interleave bytes from different records on the
 * same line. `dispose()` awaits the chain before resolving.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { LogLevel } from '@src/business/ports/logger-port.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

export interface JsonlEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly timestamp: IsoTimestamp;
  readonly context?: Record<string, unknown>;
}

export interface JsonlFileWriterOptions {
  /** Session id — used to name the file. Also persisted to records via context. */
  readonly sessionId: string;
  /** Resolved logs directory under the data root (e.g. `<root>/logs`). */
  readonly logsDir: AbsolutePath;
}

function fileFor(opts: JsonlFileWriterOptions): AbsolutePath {
  return AbsolutePath.trustString(join(opts.logsDir, `${opts.sessionId}.jsonl`));
}

export class JsonlFileWriter {
  private readonly file: AbsolutePath;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private dirReady = false;

  constructor(private readonly opts: JsonlFileWriterOptions) {
    this.file = fileFor(opts);
  }

  /** Returns the resolved file path the writer appends to. */
  get path(): AbsolutePath {
    return this.file;
  }

  /**
   * Append a single JSON record + newline to the session log. Errors are
   * swallowed into the returned `Result`; the writer never throws so a
   * disk hiccup mid-run won't crash the harness.
   */
  async write(entry: JsonlEntry): Promise<Result<void, StorageError>> {
    if (this.disposed) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: 'JsonlFileWriter has been disposed',
          path: this.file,
        })
      );
    }
    const record: Record<string, unknown> = {
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      ...(entry.context ?? {}),
    };
    const line = `${JSON.stringify(record)}\n`;

    const next = this.chain.then(async () => {
      if (!this.dirReady) {
        await mkdir(dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      await appendFile(this.file, line, 'utf-8');
    });
    // Swallow rejections in the chain so future writes still proceed.
    this.chain = next.catch(() => undefined);

    try {
      await next;
      return Result.ok();
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to append jsonl record to ${this.file}: ${err instanceof Error ? err.message : String(err)}`,
          path: this.file,
          cause: err,
        })
      );
    }
  }

  /**
   * Flush any in-flight writes and prevent further `write()` calls from
   * touching disk. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.chain;
    } catch {
      // Errors already surfaced via the originating write() call.
    }
  }
}
