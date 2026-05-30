import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { primaryFlowRow, type AiProvider, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { createInteractiveClaudeProvider } from '@src/integration/ai/providers/claude/interactive.ts';
import { createInteractiveCodexProvider } from '@src/integration/ai/providers/codex/interactive.ts';
import { createInteractiveCopilotProvider } from '@src/integration/ai/providers/copilot/interactive.ts';

/**
 * Build the concrete {@link InteractiveAiProvider} for an explicit {@link AiProvider}. The
 * provider-keyed seam (vs. the flow-keyed {@link createInteractiveAiProvider}) — used by the
 * distill sub-chain's per-distinct-provider fan-out, where the provider set is derived directly
 * (not via a flow row). Adding a provider extends this switch plus a sibling
 * `providers/<name>/interactive.ts`.
 *
 * @public
 */
export const createInteractiveAiProviderFor = (provider: AiProvider, eventBus: EventBus): InteractiveAiProvider => {
  switch (provider) {
    case 'claude-code':
      return createInteractiveClaudeProvider({ eventBus });
    case 'github-copilot':
      return createInteractiveCopilotProvider({ eventBus });
    case 'openai-codex':
      return createInteractiveCodexProvider({ eventBus });
    default: {
      const exhaustive: never = provider;
      throw new Error(`createInteractiveAiProviderFor: unhandled provider ${JSON.stringify(exhaustive)}`);
    }
  }
};

/**
 * Composition seam for {@link InteractiveAiProvider}. Selects the concrete adapter based on
 * `settings.ai[flow].provider`. Sibling of {@link createAiProvider} for the headless port.
 * Each provider has its own shell-wrapper that translates the {@link InteractiveAiProviderInput}
 * into the provider's TUI invocation.
 *
 * Adding a provider extends this switch plus a sibling `providers/<name>/interactive.ts`.
 */
export interface CreateInteractiveAiProviderDeps {
  /** Flow identifier — selects which per-flow row of `ai` carries the provider. */
  readonly flow: FlowId;
  /** AI slice of {@link Settings} — five per-flow rows. */
  readonly ai: Settings['ai'];
  /** Event bus for adapter-level logs (session start/exit). */
  readonly eventBus: EventBus;
}

export const createInteractiveAiProvider = (deps: CreateInteractiveAiProviderDeps): InteractiveAiProvider => {
  // `implement` carries a generator+evaluator pair; the interactive surface (refine, plan)
  // only runs single-session flows so this never reads the implement row in practice. Route
  // through `primaryFlowRow` defensively so a future caller passing `flow: 'implement'`
  // still resolves to a valid adapter.
  const row = primaryFlowRow(deps.ai, deps.flow);
  return createInteractiveAiProviderFor(row.provider, deps.eventBus);
};
