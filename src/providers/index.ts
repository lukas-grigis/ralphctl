import type { AiProvider } from '@src/schemas/index.ts';
import type { ProviderAdapter } from '@src/providers/types.ts';
import { claudeAdapter } from '@src/providers/claude.ts';
import { copilotAdapter } from '@src/providers/copilot.ts';
import { resolveProvider } from '@src/utils/provider.ts';
import { showWarning } from '@src/theme/ui.ts';
import { ProviderError } from '@src/errors.ts';
import { wrapAsync } from '@src/utils/result-helpers.ts';

export type { ProviderAdapter } from '@src/providers/types.ts';
export type {
  HeadlessSpawnOptions,
  ParsedOutput,
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
 *
 * Prints a warning when the resolved provider is marked experimental.
 */
export async function getActiveProvider(): Promise<ProviderAdapter> {
  const provider = await resolveProvider();
  const adapter = getProvider(provider);
  if (adapter.experimental) {
    showWarning(`${adapter.displayName} provider is in public preview — some features may not work as expected.`);
  }
  return adapter;
}

/**
 * Result-returning variant of `getActiveProvider`.
 * Returns `Result<ProviderAdapter, ProviderError>` — an error result when provider resolution fails
 * (e.g., config unreadable, interactive prompt cancelled).
 */
export function getActiveProviderResult() {
  return wrapAsync(
    () => getActiveProvider(),
    (err) =>
      new ProviderError(
        `Failed to resolve AI provider: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      )
  );
}
