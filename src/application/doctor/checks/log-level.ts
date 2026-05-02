/**
 * `logLevelCheck` — informational row that surfaces the current log level
 * resolved from `RALPHCTL_LOG_LEVEL` (default `info`).
 *
 * Always returns `'pass'` — this is a hint to help users discover the env
 * var, not a probe.
 */
import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

function resolveLevel(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['RALPHCTL_LOG_LEVEL']?.toLowerCase();
  if (raw !== undefined && VALID_LEVELS.has(raw)) return raw;
  return 'info';
}

export function logLevelCheck(env: NodeJS.ProcessEnv = process.env): Promise<DoctorCheckResult> {
  const level = resolveLevel(env);
  return Promise.resolve({
    name: 'Log level',
    status: 'pass',
    message: `Current: ${level}. Set RALPHCTL_LOG_LEVEL=debug for verbose output.`,
  });
}
