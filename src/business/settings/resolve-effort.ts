import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';

type GlobalEffort = NonNullable<Settings['ai']['effort']>;

/**
 * Shipped per-flow effort default, consulted only when neither the row nor the global effort
 * is set. Covers EVERY flow on purpose: ralphctl never leaves an effort-capable provider on its
 * CLI's built-in default, because that default moves under us — Claude Code runs Opus 5.5 at
 * `medium` when no `--effort` is passed, where every earlier Opus ran at `high`. Stamping an
 * explicit level keeps a model bump from silently changing how hard each flow thinks.
 *
 * The review flow has no row of its own — it runs on the implement generator row and therefore
 * inherits the `implement` entry. Passed through {@link clampEffortToProvider} at the call site
 * so a provider that caps below a level still resolves to one it supports. Never applied to
 * `opencode` rows (see {@link resolveEffortForRow}).
 */
const FLOW_DEFAULT_EFFORT: Readonly<Record<FlowId, GlobalEffort>> = {
  refine: 'medium',
  plan: 'high',
  implement: 'high',
  readiness: 'medium',
  ideate: 'high',
  createPr: 'low',
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
 *   4. `undefined` — only reachable for an `opencode` row with neither a row nor a global
 *      effort; the OpenCode CLI then picks the upstream model's own default.
 *
 * Floor table (per provider): the global effort vocabulary is the Claude superset
 * (`low | medium | high | xhigh | max`). Each provider may not expose every level, so a
 * global pick gets clamped to what the provider actually supports.
 *
 * For the `implement` flow this reads from the generator role — the single-row callers
 * (launcher, settings UI) want one number per flow. Per-role resolution for the implement
 * launcher goes through `resolveAgentOverride`, which lands on {@link resolveEffortForRow}.
 */
export const resolveEffort = (flow: FlowId, settings: Settings): string | undefined =>
  resolveEffortForRow(primaryFlowRow(settings.ai, flow), settings.ai.effort, flow);

/**
 * Same resolution policy as {@link resolveEffort}, but operates on an explicit row + global
 * value rather than looking the row up through {@link primaryFlowRow}. Used wherever the row is
 * not the flow's primary one: the implement launcher (generator and evaluator may carry
 * different providers), readiness and distill (both pick a row per provider).
 *
 * `flow` selects the shipped default for layer 3. It is required so no caller can silently fall
 * back to the CLI default by forgetting it.
 */
export const resolveEffortForRow = (
  row: AiFlowSettings,
  globalEffort: Settings['ai']['effort'],
  flow: FlowId
): string | undefined => {
  if (row.effort !== undefined) return row.effort;
  if (globalEffort !== undefined) return clampEffortToProvider(globalEffort, row.provider);
  // OpenCode aggregates upstream providers, so no level is known-good for the row's model — the
  // same rationale that excludes it from `EFFORT_CAPABLE_PROVIDERS` in `business/task/escalation-map.ts`.
  // Letting the CLI pick its own default is safer than stamping one the upstream model rejects.
  if (row.provider === 'opencode') return undefined;
  return clampEffortToProvider(FLOW_DEFAULT_EFFORT[flow], row.provider);
};

/**
 * Clamp an arbitrary effort string to a value the provider's adapter accepts.
 *
 * Exported so callers that source effort from somewhere other than the global-default fallback
 * (e.g. an agent-definition binding — see `resolveAgentOverride`) can still apply the same
 * per-provider floor. Codex accepts `low..xhigh` on every catalog model, so `xhigh` passes
 * through unclamped; `max` still clamps because not every codex model accepts it and this clamp
 * has no model context to narrow further. Explicit per-flow `max` / `ultra` bypasses this clamp
 * entirely (row effort returns verbatim, above) with the codex CLI as the final arbiter — same
 * policy as custom model ids.
 *
 * Per provider:
 * - claude-code: identity (its native vocabulary IS the superset).
 * - github-copilot: identity (Copilot accepts everything in the superset; `none` is only
 *   surfaced as a per-flow opt-out and never selected globally).
 * - openai-codex: `max` clamps to `xhigh`; everything else identity.
 * - opencode: identity; the CLI arbitrates, and the shipped flow default is not stamped at all.
 * - xai-grok: identity (native vocabulary includes the global superset plus `none` / `minimal`).
 *
 * Only the known-dangerous codex case is floored — any other string (including values outside
 * the superset) passes through unchanged, letting the provider CLI be the final arbiter of
 * genuinely unknown effort levels.
 */
export const clampEffortToProvider = (effort: string, provider: AiProvider): string => {
  if (provider === 'openai-codex' && effort === 'max') return 'xhigh';
  return effort;
};
