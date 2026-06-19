import { Result } from '@src/domain/result.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * In-memory recording `WriteFile` for unit / integration tests. Captures every write by path
 * (last-write-wins, mirroring an atomic overwrite on disk) so tests can assert on the written
 * content without touching the filesystem. Used for the derived `learnings.md` mirror and any other
 * `WriteFile` consumer that does not need a real file.
 */
export interface RecordingWriteFile {
  /** The `WriteFile` to inject into the system under test. */
  readonly fn: WriteFile;
  /** Read the last-written content for one path; `undefined` if the path was never written. */
  readonly read: (path: AbsolutePath) => string | undefined;
  /** Snapshot every path that was written, in first-write order. */
  readonly paths: () => readonly string[];
}

export const recordingWriteFile = (): RecordingWriteFile => {
  const store = new Map<string, string>();
  const order: string[] = [];
  const fn: WriteFile = async (path, content) => {
    const key = String(path);
    if (!store.has(key)) order.push(key);
    store.set(key, content);
    return Result.ok(undefined);
  };
  return {
    fn,
    read: (path) => store.get(String(path)),
    paths: () => [...order],
  };
};
