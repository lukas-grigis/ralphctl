import { getPrompt } from '@src/integration/bootstrap.ts';
import type { AiProvider } from '@src/domain/models.ts';
import { getAiProvider, setAiProvider } from '@src/integration/persistence/config.ts';
import { emoji } from '@src/integration/ui/theme/ui.ts';

/**
 * Resolve the active AI provider.
 * Reads from config; if not set, prompts the user to choose and saves the selection.
 */
export async function resolveProvider(): Promise<AiProvider> {
  const stored = await getAiProvider();
  if (stored) return stored;

  const choice = await getPrompt().select<AiProvider>({
    message: `${emoji.donut} Which AI buddy should help with my homework?`,
    choices: [
      { label: 'Claude Code', value: 'claude' as const },
      { label: 'GitHub Copilot', value: 'copilot' as const },
    ],
  });

  await setAiProvider(choice);
  return choice;
}

/** Human-readable display name for a provider. */
export function providerDisplayName(provider: AiProvider): string {
  return provider === 'claude' ? 'Claude' : 'Copilot';
}

/** CLI binary name for a provider. */
export function providerBinary(provider: AiProvider): string {
  return provider === 'claude' ? 'claude' : 'copilot';
}
