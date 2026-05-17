import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Allocate a unique temp directory and return it as an `AbsolutePath` plus a `cleanup`
 * function the caller invokes in `afterEach`. macOS resolves `/var/folders/...` symlinks via
 * `realpath` so the returned path is canonical and matches what the storage layer will see
 * after its own resolves.
 */
export const makeTmpRoot = async (): Promise<{
  readonly root: AbsolutePath;
  readonly cleanup: () => Promise<void>;
}> => {
  const raw = await fs.mkdtemp(join(tmpdir(), 'ralphctl-v2-persistence-'));
  const resolved = await realpath(raw);
  const parsed = AbsolutePath.parse(resolved);
  if (!parsed.ok) throw new Error(`tmp dir is not a valid AbsolutePath: ${resolved}`);
  const root = parsed.value;
  return {
    root,
    cleanup: async () => {
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
};
