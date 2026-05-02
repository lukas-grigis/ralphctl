/**
 * `gitIdentityCheck` — confirms `user.name` and `user.email` are set.
 *
 * Missing identity is a `warn` (not `fail`): it only matters when the
 * harness creates auto-commits via `recover-dirty-tree`. CI runners
 * routinely have it unset, and we don't want to red-flag those.
 */
import { spawnSync } from 'node:child_process';

import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';

function readGitConfig(key: string): string {
  const result = spawnSync('git', ['config', '--get', key], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

export function gitIdentityCheck(): Promise<DoctorCheckResult> {
  const name = readGitConfig('user.name');
  const email = readGitConfig('user.email');

  if (name && email) {
    return Promise.resolve({
      name: 'Git identity',
      status: 'pass',
      message: `${name} <${email}>`,
    });
  }

  const missing: string[] = [];
  if (!name) missing.push('user.name');
  if (!email) missing.push('user.email');

  return Promise.resolve({
    name: 'Git identity',
    status: 'warn',
    message: `missing: ${missing.join(', ')}`,
  });
}
