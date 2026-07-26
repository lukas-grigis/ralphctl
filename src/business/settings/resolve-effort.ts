import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
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
 * Clamp an arbitrary effort string to a value the provider's adapter accepts.
 *
 * Exported so callers that source effort from somewhere other than the global-default fallback
 * (e.g. an agent-definition binding — see `resolveAgentOverride`) can still apply the same
 * per-provider floor. Codex accepts `low..xhigh` on every catalog model, so `xhigh` now passes
 * through unclamped; `max` still clamps because only the 5.6 family accepts it and this clamp
 * has no model context to narrow further. Explicit per-flow `max` / `ultra` bypasses this clamp
 * entirely (row effort returns verbatim, below) with the codex CLI as the final arbiter — same
 * policy as custom model ids.
 *
 * Only the known-dangerous codex case is floored — any other string (including values outside
 * the superset) passes through unchanged, letting the provider CLI be the final arbiter of
 * genuinely unknown effort levels.
 */
export const clampEffortToProvider = (effort: string, provider: AiProvider): string => {
  if (provider === 'openai-codex' && effort === 'max') return 'xhigh';
  return effort;
};

/**
 * Clamp the unified global effort to a value the provider's adapter accepts.
 *
 * - claude-code: identity (its native vocabulary IS the superset).
 * - github-copilot: identity (Copilot accepts everything in the superset; `none` is only
 *   surfaced as a per-flow opt-out and never selected globally).
 * - openai-codex: `max` clamps to `xhigh`; everything else identity.
 */
const _floorForProvider = (effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max', provider: AiProvider): string =>
  clampEffortToProvider(effort, provider);
