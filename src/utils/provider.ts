import { select } from '@inquirer/prompts';
import type { AiProvider } from '@src/schemas/index.ts';
import { getAiProvider, setAiProvider } from '@src/store/config.ts';
import { emoji } from '@src/theme/ui.ts';

/**
 * Resolve the active AI provider.
 * Reads from config; if not set, prompts the user to choose and saves the selection.
 */
export async function resolveProvider(): Promise<AiProvider> {
  const stored = await getAiProvider();
  if (stored) return stored;

  const choice = await select<AiProvider>({
    message: `${emoji.donut} Which AI buddy should help with my homework?`,
    choices: [
      { name: 'Claude Code', value: 'claude' as const },
      { name: 'GitHub Copilot', value: 'copilot' as const },
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
