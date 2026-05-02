/**
 * `aiProviderInstalledCheck` — verifies the configured AI provider's
 * binary is available on `PATH`.
 *
 * Skipped (not failed) when no provider is configured — the user can
 * still run non-AI commands. The provider binary lookup uses the OS
 * `which`/`where` shell command rather than a custom path scan; we
 * already trust `which` everywhere else in the harness.
 */
import { spawnSync } from 'node:child_process';

import type { ConfigStorePort } from '@src/application/config/config-store-port.ts';
import type { DoctorCheckResult } from '@src/application/doctor/run-doctor.ts';

export interface AiProviderInstalledCheckDeps {
  readonly configStore: ConfigStorePort;
}

export async function aiProviderInstalledCheck(deps: AiProviderInstalledCheckDeps): Promise<DoctorCheckResult> {
  const loaded = await deps.configStore.load();
  if (!loaded.ok) {
    return {
      name: 'AI provider binary',
      status: 'fail',
      message: `failed to load config: ${loaded.error.message}`,
    };
  }
  const provider = loaded.value.aiProvider;
  if (provider === null) {
    return {
      name: 'AI provider binary',
      status: 'skip',
      message: 'not configured',
    };
  }

  const binary = provider === 'claude' ? 'claude' : 'copilot';
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', [binary], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (lookup.status === 0) {
    return {
      name: 'AI provider binary',
      status: 'pass',
      message: `${binary} found`,
    };
  }
  return {
    name: 'AI provider binary',
    status: 'fail',
    message: `${binary} not found in PATH (provider: ${provider})`,
  };
}
