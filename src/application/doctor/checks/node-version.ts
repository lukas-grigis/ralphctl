/**
 * `nodeVersionCheck` — confirms Node.js >= 24.0.0.
 *
 * The harness uses node:test features and ESM-only modules that require
 * Node 24. Running on an older runtime is a hard fail, not a warning.
 */
import type { DoctorCheckResult } from '../run-doctor.ts';

const REQUIRED_MAJOR = 24;

export function nodeVersionCheck(): Promise<DoctorCheckResult> {
  // `process.versions.node` is e.g. `'24.1.0'` (no `v` prefix). Using it
  // over `process.version` lets us skip a regex.
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0] ?? '0', 10);

  if (Number.isFinite(major) && major >= REQUIRED_MAJOR) {
    return Promise.resolve({
      name: 'Node.js version',
      status: 'pass',
      message: `v${version}`,
    });
  }

  return Promise.resolve({
    name: 'Node.js version',
    status: 'fail',
    message: `v${version} (requires >= ${String(REQUIRED_MAJOR)}.0.0)`,
  });
}
