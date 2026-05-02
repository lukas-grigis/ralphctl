/**
 * `dataDirWritableCheck` — confirms the data directory is writable.
 *
 * `access(W_OK)` alone is not enough — some filesystems (FUSE mounts,
 * read-only-snapshot bind mounts) report the bit as set but reject the
 * actual write. We round-trip a tiny temp file to validate end-to-end.
 *
 * Side-effect: creates `dataDir` (recursive) before probing. The
 * composition root no longer ensures the layout eagerly (so `--version`
 * / `--help` / `completion show` don't materialise it), and `doctor` is
 * a write-shaped probe by design — creating the dir to test it is the
 * intent.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoragePaths } from '@src/application/runtime/storage-paths-resolver.ts';
import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';

export interface DataDirWritableCheckDeps {
  readonly storage: StoragePaths;
}

export async function dataDirWritableCheck(deps: DataDirWritableCheckDeps): Promise<DoctorCheckResult> {
  const probe = join(deps.storage.dataDir, `.doctor-write-${String(process.pid)}-${String(Date.now())}.tmp`);
  try {
    await mkdir(deps.storage.dataDir, { recursive: true });
    await writeFile(probe, 'doctor', { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    return {
      name: 'Data directory',
      status: 'fail',
      message: `${deps.storage.dataDir} not writable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Cleanup is best-effort; the directory write succeeded so the result
  // is already pass.
  try {
    await unlink(probe);
  } catch {
    // ignore
  }
  return {
    name: 'Data directory',
    status: 'pass',
    message: deps.storage.dataDir,
  };
}
