import type { AiProvider } from '@src/domain/models.ts';
import type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';
import { claudeAdapter } from '@src/integration/ai/providers/claude.ts';
import { copilotAdapter } from '@src/integration/ai/providers/copilot.ts';
import { resolveProvider } from '@src/integration/external/provider.ts';
import { ProviderError } from '@src/domain/errors.ts';
import { wrapAsync } from '@src/integration/utils/result-helpers.ts';

export type { ProviderAdapter } from '@src/integration/ai/providers/types.ts';
export type {
  HeadlessSpawnOptions,
  ParsedOutput,
  RateLimitInfo,
  SpawnAsyncOptions,
  SpawnInteractiveResult,
  SpawnResult,
  SpawnSyncOptions,
} from '@src/integration/ai/providers/types.ts';

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
 * The "experimental" status of a provider is surfaced by `ralphctl doctor` —
 * we deliberately do not stdout-write here because this function is called
 * during Ink-mounted pipelines (plan / refine / ideate / execute), and any
 * direct stdout write would bleed into the alt-screen buffer.
 */
export async function getActiveProvider(): Promise<ProviderAdapter> {
  const provider = await resolveProvider();
  return getProvider(provider);
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
