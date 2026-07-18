import type { AiFlowSettings, Settings } from '@src/domain/entity/settings.ts';
import { clampEffortToProvider, resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';

/**
 * The subset of an `AgentDefinition` this resolver needs. Declared locally rather than
 * imported — the integration-side `AgentDefinition` type lives in `integration/ai/agents/`,
 * an outer layer business code may not depend on. Any object carrying `model?`/`effort?`
 * satisfies this, including an actual `AgentDefinition`.
 */
export interface AgentOverrideHints {
  readonly model?: string;
  readonly effort?: string;
}

/** Effective model/effort for one implement role after applying the override precedence. */
export interface ResolvedAgentOverride {
  readonly model: string;
  readonly effort: string | undefined;
}

/**
 * Resolve the effective model and effort for one implement role, applying the precedence
 * bound definition > per-flow row > global default.
 *
 * - `model`: the definition's `model` when set, otherwise the row's own `model` (always
 *   present — every {@link AiFlowSettings} row is fully stamped with a provider-catalog model).
 * - `effort`: the definition's `effort` when set, but floored to the row's provider (e.g. an
 *   agent definition's `xhigh`/`max` clamps to `high` on a codex row, same as the global-default
 *   path — see {@link clampEffortToProvider}); otherwise {@link resolveEffortForRow}'s result
 *   (per-flow row effort, falling through to the global default floored to the row's provider).
 *
 * `binding` is `undefined` when the role has no bound definition — resolution then falls
 * straight through to the per-flow row / global default, identical to `resolveEffortForRow`
 * plus the row's own model.
 */
export const resolveAgentOverride = (
  row: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  binding: AgentOverrideHints | undefined
): ResolvedAgentOverride => ({
  model: binding?.model ?? row.model,
  effort:
    binding?.effort !== undefined
      ? clampEffortToProvider(binding.effort, row.provider)
      : resolveEffortForRow(row, globalEffort),
});
