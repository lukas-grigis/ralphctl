import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Reads the trailing bytes of a UTF-8 log so the TUI can lazy-load a {@link SetupRun} /
 * {@link VerifyRun} body that is never persisted on the row. Display-only: a missing file or a read
 * error yields `undefined`, never a throw. The adapter caps the read so a popover never streams an
 * unbounded body into memory.
 */
export type LogTailReader = (path: AbsolutePath, maxBytes?: number) => Promise<string | undefined>;
