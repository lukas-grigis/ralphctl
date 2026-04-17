import { spawnSync } from 'node:child_process';
import { assertSafeCwd } from '@src/integration/persistence/paths.ts';

/** Lifecycle events where hooks can fire. Extend this union for new phases. */
export type LifecycleEvent = 'sprintStart' | 'taskComplete';

export interface HookResult {
  passed: boolean;
  output: string;
}

/** Default timeout for lifecycle hooks: 5 minutes. Override via RALPHCTL_SETUP_TIMEOUT_MS. */
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;

function getHookTimeoutMs(): number {
  const envVal = process.env['RALPHCTL_SETUP_TIMEOUT_MS'];
  if (envVal) {
    const parsed = Number(envVal);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * Run a lifecycle hook script in a project directory.
 *
 * Scripts are user-configured via `project add` or `project repo add` —
 * they are NOT arbitrary AI-generated commands.
 */
export function runLifecycleHook(
  projectPath: string,
  script: string,
  event: LifecycleEvent,
  timeoutOverrideMs?: number
): HookResult {
  assertSafeCwd(projectPath);
  const timeoutMs = timeoutOverrideMs ?? getHookTimeoutMs();

  const result = spawnSync(script, {
    cwd: projectPath,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env, RALPHCTL_LIFECYCLE_EVENT: event },
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { passed: result.status === 0, output };
}
