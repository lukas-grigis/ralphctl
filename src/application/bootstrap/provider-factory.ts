import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

/**
 * Composition seam for {@link HeadlessAiProvider}. Selects the concrete adapter based on
 * `ai.provider`. The switch is exhaustive — adding a provider extends this factory plus a
 * sibling adapter file under `ai/providers/<name>/`. Model tier flows per call via
 * {@link AiSession}; this factory only carries operational concerns (timeout, retry budget,
 * log sink, spawn seam).
 */
export interface CreateAiProviderDeps {
  /** AI slice of {@link Settings} — provider id + per-chain models. */
  readonly ai: Settings['ai'];
  /** Harness slice — call timeout + rate-limit retries threaded into the adapter. */
  readonly harnessConfig: Settings['harness'];
  /** Adapter-level event bus — providers publish 'log' AppEvents (session id, retries, raw stdout at debug level). */
  readonly eventBus: EventBus;
  /**
   * Optional spawn override — production uses the default `node:child_process.spawn`. Tests
   * (notably the wire integration test) pass a fake so a real `claude` binary is not
   * required to exercise the wiring.
   */
  readonly spawn?: ProviderSpawn;
}

export const createAiProvider = (deps: CreateAiProviderDeps): HeadlessAiProvider => {
  switch (deps.ai.provider) {
    case 'claude-code':
      return createClaudeProvider({
        rateLimitRetries: deps.harnessConfig.rateLimitRetries,
        eventBus: deps.eventBus,
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      });
    case 'github-copilot':
      return createCopilotProvider({
        rateLimitRetries: deps.harnessConfig.rateLimitRetries,
        eventBus: deps.eventBus,
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      });
    case 'openai-codex':
      return createCodexProvider({
        rateLimitRetries: deps.harnessConfig.rateLimitRetries,
        eventBus: deps.eventBus,
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      });
    default: {
      // Exhaustiveness — every branch of the AiSettings discriminated union is now handled;
      // a future provider added to the schema would surface here at compile time.
      const exhaustive: never = deps.ai;
      throw new Error(`createAiProvider: unhandled provider ${JSON.stringify(exhaustive)}`);
    }
  }
};
