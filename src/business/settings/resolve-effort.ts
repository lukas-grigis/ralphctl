import { primaryFlowRow, type AiFlowSettings, type AiProvider, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

/**
 * Resolve the effort level the AI provider adapter should request for one flow.
 *
 * Resolution order:
 *   1. Per-flow `settings.ai[flow].effort` if explicitly set.
 *   2. Global `settings.ai.effort`, floored to the flow's provider ceiling.
 *   3. `undefined` — the adapter falls back to the CLI's built-in default.
 *
 * Floor table (per provider): the global effort vocabulary is the Claude superset
 * (`low | medium | high | xhigh | max`). Each provider may not expose every level, so a
 * global pick gets clamped to what the provider actually supports.
 *
 * For the `implement` flow this reads from the generator role — the legacy single-row
 * callers (provider factory, settings UI) want one number per flow. Per-role evaluator
 * effort is read directly off `settings.ai.implement.evaluator.effort` at the spawn site.
 */
export const resolveEffort = (flow: FlowId, settings: Settings): string | undefined => {
  const row = primaryFlowRow(settings.ai, flow);
  return resolveEffortForRow(row, settings.ai.effort);
};

/**
 * Same resolution policy as {@link resolveEffort}, but operates on an explicit row + global
 * value rather than looking the row up through {@link primaryFlowRow}. Used by the implement
 * launcher to resolve effort per role (generator / evaluator) when the two roles may carry
 * different providers and effort floors.
 */
export const resolveEffortForRow = (
  row: AiFlowSettings,
  globalEffort: Settings['ai']['effort']
): string | undefined => {
  if (row.effort !== undefined) return row.effort;
  if (globalEffort === undefined) return undefined;
  return _floorForProvider(globalEffort, row.provider);
};

/**
 * Clamp the unified global effort to a value the provider's adapter accepts.
 *
 * - claude-code: identity (its native vocabulary IS the superset).
 * - github-copilot: identity (Copilot accepts everything in the superset; `none` is only
 *   surfaced as a per-flow opt-out and never selected globally).
 * - openai-codex: `minimal | low | medium | high`. `xhigh` / `max` clamp to `high`.
 */
const _floorForProvider = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', provider: AiProvider): string => {
  switch (provider) {
    case 'claude-code':
    case 'github-copilot':
      return effort;
    case 'openai-codex': {
      if (effort === 'xhigh' || effort === 'max') return 'high';
      return effort;
    }
  }
};
