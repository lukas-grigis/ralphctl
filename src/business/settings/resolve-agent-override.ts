import type { AiFlowSettings, Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { floorEffort, resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';

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
 * - `effort`: the definition's `effort` when set, but clamped to the effective model's effort list
 *   (see {@link floorEffort} — a model without effort gets none); otherwise {@link resolveEffortForRow}'s result (per-flow row
 *   effort, then the global default floored to the row's provider, then `flow`'s shipped
 *   default — so an unconfigured implement role still gets an explicit level rather than the
 *   CLI's own default).
 *
 * `binding` is `undefined` when the role has no bound definition — resolution then falls
 * straight through to the per-flow row / global default / flow default, identical to
 * `resolveEffortForRow` plus the row's own model.
 */
export const resolveAgentOverride = (
  row: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  binding: AgentOverrideHints | undefined,
  flow: FlowId
): ResolvedAgentOverride => {
  const model = binding?.model ?? row.model;
  // Resolve against the EFFECTIVE model — a binding may swap in one with a different effort list.
  const effort =
    binding?.effort !== undefined
      ? floorEffort(binding.effort, row.provider, model)
      : resolveEffortForRow({ ...row, model }, globalEffort, flow);
  return { model, effort };
};
