import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { createInteractiveClaudeProvider } from '@src/integration/ai/providers/claude/interactive.ts';
import { createInteractiveCodexProvider } from '@src/integration/ai/providers/codex/interactive.ts';
import { createInteractiveCopilotProvider } from '@src/integration/ai/providers/copilot/interactive.ts';

/**
 * Composition seam for {@link InteractiveAiProvider}. Selects the concrete adapter based on
 * `ai.provider`. Sibling of {@link createAiProvider} for the headless port. Each provider has
 * its own shell-wrapper that translates the {@link InteractiveAiProviderInput} into the
 * provider's TUI invocation:
 *
 *  - claude  → `claude --add-dir <cwd> --model <m> --permission-mode acceptEdits "$(cat <prompt>)"`
 *  - codex   → `codex --cd <cwd> --model <m> -s workspace-write -a never "$(cat <prompt>)"`
 *  - copilot → `copilot --add-dir=<cwd> --model=<m> --allow-all-tools -i <prompt>` (equals-only flags)
 *
 * Adding a provider extends this switch plus a sibling `providers/<name>/interactive.ts`.
 */
export interface CreateInteractiveAiProviderDeps {
  /** AI slice of {@link Settings} — provider id is all this factory needs. */
  readonly ai: Settings['ai'];
  /** Event bus for adapter-level logs (session start/exit). */
  readonly eventBus: EventBus;
}

export const createInteractiveAiProvider = (deps: CreateInteractiveAiProviderDeps): InteractiveAiProvider => {
  switch (deps.ai.provider) {
    case 'claude-code':
      return createInteractiveClaudeProvider({ eventBus: deps.eventBus });
    case 'github-copilot':
      return createInteractiveCopilotProvider({ eventBus: deps.eventBus });
    case 'openai-codex':
      return createInteractiveCodexProvider({ eventBus: deps.eventBus });
    default: {
      const exhaustive: never = deps.ai;
      throw new Error(`createInteractiveAiProvider: unhandled provider ${JSON.stringify(exhaustive)}`);
    }
  }
};
