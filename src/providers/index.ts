import type { AiProvider } from '@src/schemas/index.ts';
import type { ProviderAdapter } from '@src/providers/types.ts';
import { claudeAdapter } from '@src/providers/claude.ts';
import { copilotAdapter } from '@src/providers/copilot.ts';
import { resolveProvider } from '@src/utils/provider.ts';

export type { ProviderAdapter } from '@src/providers/types.ts';
export type {
  HeadlessSpawnOptions,
  RateLimitInfo,
  SpawnAsyncOptions,
  SpawnInteractiveResult,
  SpawnResult,
  SpawnSyncOptions,
} from '@src/providers/types.ts';

/**
 * Get the adapter for a specific provider.
 */
export function getProvider(provider: AiProvider): ProviderAdapter {
  switch (provider) {
    case 'claude':
      return claudeAdapter;
    case 'copilot':
      return copilotAdapter;
  }
}

/**
 * Resolve the active provider from config (prompting on first use)
 * and return its adapter.
 */
export async function getActiveProvider(): Promise<ProviderAdapter> {
  const provider = await resolveProvider();
  return getProvider(provider);
}
