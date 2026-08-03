import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { createClaudeProvider } from '@src/integration/ai/providers/claude/headless.ts';
import { createCodexProvider } from '@src/integration/ai/providers/codex/headless.ts';
import { createCopilotProvider } from '@src/integration/ai/providers/copilot/headless.ts';
import type { ProviderSpawn } from '@src/integration/ai/providers/_engine/spawn.ts';
import type { HeadlessProviderDeps } from '@src/integration/ai/providers/_engine/headless-provider-deps.ts';

/**
 * Composition seam for {@link HeadlessAiProvider}. Selects the concrete adapter based on the
 * provider field of a per-flow row, via {@link HEADLESS_FACTORIES} — `Readonly<Record<AiProvider,
 * …>>` gives the same exhaustiveness a `switch` + `never` default gave (a provider added to the
 * union without a row here is a compile error), without a throw at the default branch. Adding a
 * provider extends the record plus a sibling adapter file under `ai/providers/<name>/`. Model
 * tier flows per call via {@link AiSession}; this factory only carries operational concerns
 * (rate-limit retry budget, log sink, spawn seam).
 *
 * Two input shapes are accepted: either a `flow` id (legacy single-row consumers — readiness
 * inventory, settings-view rebuild) that resolves through {@link primaryFlowRow}, or an
 * explicit `row` (the implement launcher, which builds one provider per role from
 * `ai.implement.generator` and `ai.implement.evaluator` independently). The two paths share
 * the same provider dispatch.
 */
export interface CreateAiProviderDepsBase {
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

export interface CreateAiProviderDepsByFlow extends CreateAiProviderDepsBase {
  /** Flow identifier — selects which per-flow row of `ai` carries the provider. */
  readonly flow: FlowId;
  /** AI slice of {@link Settings} — five per-flow rows + optional global effort. */
  readonly ai: Settings['ai'];
}

export interface CreateAiProviderDepsByRow extends CreateAiProviderDepsBase {
  /**
   * Explicit per-role row — bypasses {@link primaryFlowRow} lookup. Used by the implement
   * launcher to materialise a distinct provider per generator / evaluator role from the same
   * `ai.implement` pair without round-tripping through a flow id.
   */
  readonly row: AiFlowSettings;
}

export type CreateAiProviderDeps = CreateAiProviderDepsByFlow | CreateAiProviderDepsByRow;

const resolveRow = (deps: CreateAiProviderDeps): AiFlowSettings => {
  if ('row' in deps) return deps.row;
  // `implement` carries a {generator, evaluator} pair — the legacy single-session callers
  // (readiness inventory, settings TUI) read the generator row via `primaryFlowRow`. Spawn
  // sites that need the evaluator role pass `{ row: ai.implement.evaluator }` directly.
  return primaryFlowRow(deps.ai, deps.flow);
};

/**
 * One concrete headless-provider factory per {@link AiProvider}. `Record<AiProvider, …>` is
 * checked exhaustively by the compiler — adding a member to the `AiProvider` union without a
 * row here is a compile error.
 */
const HEADLESS_FACTORIES: Readonly<Record<AiProvider, (deps: HeadlessProviderDeps) => HeadlessAiProvider>> = {
  'claude-code': createClaudeProvider,
  'github-copilot': createCopilotProvider,
  'openai-codex': createCodexProvider,
};

export const createAiProvider = (deps: CreateAiProviderDeps): HeadlessAiProvider => {
  const row = resolveRow(deps);
  return HEADLESS_FACTORIES[row.provider]({
    rateLimitRetries: deps.harnessConfig.rateLimitRetries,
    idleMs: deps.harnessConfig.idleWatchdogMs,
    eventBus: deps.eventBus,
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
  });
};
