import { dirname, join } from 'node:path';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/**
 * Persist a captured session id next to `signals.json` so `--resume` / forensic re-attach works
 * without log parsing.
 *
 * The CLAUDE.md contract states "providers write `signals.json` + `session-id.txt` files per
 * spawn" — historically only `signals.json` landed on disk; session ids escaped into `chain.log`.
 * This helper closes that gap: every adapter calls it after writing `signals.json`, passing the
 * same directory's signals path and the id its provider captured.
 *
 * File layout:
 *   - `signals.json` is written by the adapter at `session.signalsFile`.
 *   - This helper writes `session-id.txt` as a sibling in the same directory.
 *
 * Contents:
 *   - Plain UTF-8, exactly one line containing the session id, trailing newline. Matches the
 *     convention of other text artifacts under `<sprintDir>/<flow>/<unit-slug>/` (prompt.md,
 *     done-criteria.md).
 *
 * Skip-on-undefined:
 *   - If the provider failed to capture an id (process crashed before reporting, malformed
 *     stream-json envelope, …), the helper writes nothing and returns `Result.ok`. Writing an
 *     empty file would create a garbage marker indistinguishable from a real id of "" — better
 *     to leave the file absent so callers can detect "no id captured."
 *
 * Atomicity:
 *   - Delegates to {@link writeTextAtomic} (tmpfile + rename) — readers see either the prior id
 *     or the full new id, never a half-written file.
 */
export const persistSessionIdFile = async (
  signalsFile: AbsolutePath,
  sessionId: string | undefined
): Promise<Result<void, StorageError> | undefined> => {
  if (sessionId === undefined) return undefined;
  const path = join(dirname(String(signalsFile)), 'session-id.txt');
  return writeTextAtomic(path, `${sessionId}\n`);
};
