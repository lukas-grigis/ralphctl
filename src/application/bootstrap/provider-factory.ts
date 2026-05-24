import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';

/**
 * Composition seam for {@link HeadlessAiProvider}. Selects the concrete adapter based on
 * `settings.ai[flow].provider`. The switch is exhaustive — adding a provider extends this
 * factory plus a sibling adapter file under `ai/providers/<name>/`. Model tier flows per
 * call via {@link AiSession}; this factory only carries operational concerns (rate-limit
 * retry budget, log sink, spawn seam).
 */
export interface CreateAiProviderDeps {
  /** Flow identifier — selects which per-flow row of `ai` carries the provider. */
  readonly flow: FlowId;
  /** AI slice of {@link Settings} — five per-flow rows + optional global effort. */
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
  // `implement` carries a {generator, evaluator} pair — the legacy single-session callers
  // (per-launch adapter rebuild, readiness inventory) read the generator row. Spawn sites
  // that need the evaluator role construct a second adapter from `ai.implement.evaluator`.
  const row = primaryFlowRow(deps.ai, deps.flow);
  switch (row.provider) {
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
      // Exhaustiveness — every branch of the per-flow row's provider union is handled.
      const exhaustive: never = row;
      throw new Error(`createAiProvider: unhandled provider ${JSON.stringify(exhaustive)}`);
    }
  }
};
