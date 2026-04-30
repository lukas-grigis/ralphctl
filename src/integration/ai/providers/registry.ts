/**
 * Static registry of {@link ProviderAdapter} implementations keyed by
 * {@link AiProvider}. The session adapter resolves the active provider
 * from config (lazily) and looks the adapter up here.
 */
import type { AiProvider } from '../../../business/ports/ai-session-port.ts';
import { claudeAdapter } from './claude-adapter.ts';
import { copilotAdapter } from './copilot-adapter.ts';
import type { ProviderAdapter } from './types.ts';

export const adapters: Readonly<Record<AiProvider, ProviderAdapter>> = {
  claude: claudeAdapter,
  copilot: copilotAdapter,
};

export function getAdapter(name: AiProvider): ProviderAdapter {
  return adapters[name];
}
