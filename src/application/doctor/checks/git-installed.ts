/**
 * `gitInstalledCheck` — verifies the `git` binary is in `PATH`.
 *
 * Runs `git --version` directly via `spawnSync` because the integration
 * `GitRunner` is repo-scoped (`cwd` required) and this probe is repo-
 * agnostic. Self-contained = no DI plumbing for a one-off probe.
 */
import { spawnSync } from 'node:child_process';

import type { DoctorCheckResult } from '../run-doctor.ts';

export function gitInstalledCheck(): Promise<DoctorCheckResult> {
  const result = spawnSync('git', ['--version'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    return Promise.resolve({
      name: 'Git installed',
      status: 'pass',
      message: result.stdout.trim(),
    });
  }

  return Promise.resolve({
    name: 'Git installed',
    status: 'fail',
    message: 'git not found in PATH',
  });
}
