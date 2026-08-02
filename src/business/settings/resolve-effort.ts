import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

/**
 * Shipped per-flow effort default, consulted only when neither the row nor the global effort
 * is set. Deliberately narrow — `plan` and `ideate` only — since every other flow must keep
 * resolving to `undefined` (CLI default) exactly as it does today. Passed through
 * {@link clampEffortToProvider} at the call site so a provider that caps below `high` still
 * resolves to its highest supported level instead of an invalid value.
 */
const FLOW_DEFAULT_EFFORT: Partial<Record<FlowId, 'high'>> = {
  plan: 'high',
  ideate: 'high',
};

/**
 * Resolve the effort level the AI provider adapter should request for one flow.
 *
 * Resolution order:
 *   1. Per-flow `settings.ai[flow].effort` if explicitly set.
 *   2. Global `settings.ai.effort`, floored to the flow's provider ceiling.
 *   3. The flow's shipped default effort (see {@link FLOW_DEFAULT_EFFORT}), floored to the
 *      flow's provider ceiling — deliberately BELOW the global default: an operator who set
 *      `ai.effort` has made a deliberate choice, and the shipped default must not override it.
 *   4. `undefined` — the adapter falls back to the CLI's built-in default.
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
  return resolveEffortForRow(row, settings.ai.effort, flow);
};

/**
 * Same resolution policy as {@link resolveEffort}, but operates on an explicit row + global
 * value rather than looking the row up through {@link primaryFlowRow}. Used by the implement
 * launcher to resolve effort per role (generator / evaluator) when the two roles may carry
 * different providers and effort floors.
 *
 * `flow` is optional and consulted only for the third resolution layer (the shipped per-flow
 * default) — existing two-argument call sites (`resolveAgentOverride`, and through it the
 * implement launcher) are unaffected, since `implement` carries no entry in
 * {@link FLOW_DEFAULT_EFFORT} regardless.
 */
export const resolveEffortForRow = (
  row: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  flow?: FlowId
): string | undefined => {
  if (row.effort !== undefined) return row.effort;
  if (globalEffort !== undefined) return _floorForProvider(globalEffort, row.provider);
  const flowDefault = flow !== undefined ? FLOW_DEFAULT_EFFORT[flow] : undefined;
  if (flowDefault !== undefined) return clampEffortToProvider(flowDefault, row.provider);
  return undefined;
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
