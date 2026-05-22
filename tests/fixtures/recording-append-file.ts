import { Result } from '@src/domain/result.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * In-memory recording `AppendFile` for unit / e2e tests. Captures every appended chunk by
 * path so tests can assert on the journaled content without touching the filesystem.
 *
 * Multiple appends to the same path concatenate in call order — exactly mirrors what a real
 * file on disk would look like at the end of the run.
 */
export interface RecordingAppendFile {
  /** The `AppendFile` to inject into the system under test. */
  readonly fn: AppendFile;
  /** Snapshot every captured write — path + the concatenated content. */
  readonly snapshot: () => ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /** Read the accumulated content for one path; returns `undefined` if the path was never appended to. */
  readonly read: (path: AbsolutePath) => string | undefined;
}

export const recordingAppendFile = (): RecordingAppendFile => {
  const store = new Map<string, string>();
  const fn: AppendFile = async (path, text) => {
    const key = String(path);
    const prior = store.get(key) ?? '';
    store.set(key, prior + text);
    return Result.ok(undefined);
  };
  return {
    fn,
    snapshot: () => [...store.entries()].map(([path, content]) => ({ path, content })),
    read: (path) => store.get(String(path)),
  };
};
