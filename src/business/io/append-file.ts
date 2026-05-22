import type { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Output port for appending text to a file by absolute path. Mirrors {@link WriteFile} but for
 * journal-style write-once-and-grow artefacts — `<sprintDir>/progress.md` (the append-only
 * sprint journal, see audit-[07]) and `<sprintDir>/events.ndjson` (opt-in debug trace).
 *
 * Implementations create parent directories as needed and create the file if absent
 * (so a journal-style appender doesn't have to pre-touch the path).
 *
 * Why a port, not `fs.appendFile` directly: POSIX `fs.appendFile` is atomic only up to
 * PIPE_BUF (~4 KiB). A journal section with long critique easily exceeds that, so the
 * adapter combines an atomic read-concat-rewrite for the journal use case. Owning it as a
 * port also makes leaf-level tests assert against a recording fake — no filesystem I/O.
 *
 * ESLint fences direct `fs.appendFile` outside `integration/io/`; business + application code
 * goes through this port.
 */
export type AppendFile = (path: AbsolutePath, text: string) => Promise<Result<void, StorageError>>;
