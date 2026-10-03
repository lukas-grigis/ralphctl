import { type AiFlowSettings, type AiProvider, primaryFlowRow, type Settings } from '@src/domain/entity/settings.ts';
import type { FlowId } from '@src/domain/value/flow-id.ts';
import { modelEffortLevels } from '@src/domain/value/settings-models/effort.ts';

/** Weakest → strongest across every provider vocabulary; ranks levels for the model clamp. */
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

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
 *
 * Every layer is then narrowed to the row's model ({@link clampEffortToModel} / {@link floorEffort}):
 * a catalog model with a known effort list never receives a level its CLI rejects, and a model with
 * no effort dimension gets none.
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
  if (row.effort !== undefined) return clampEffortToModel(row.effort, row.provider, row.model);
  if (globalEffort !== undefined) return floorEffort(globalEffort, row.provider, row.model);
  // OpenCode aggregates upstream providers, so no level is known-good for the row's model — the
  // same rationale that excludes it from `EFFORT_CAPABLE_PROVIDERS` in `business/task/escalation-map.ts`.
  // Letting the CLI pick its own default is safer than stamping one the upstream model rejects.
  if (row.provider === 'opencode') return undefined;
  return floorEffort(FLOW_DEFAULT_EFFORT[flow], row.provider, row.model);
};

/**
 * Provider-level floor — the fallback {@link floorEffort} uses when the catalog has no effort list
 * for the row's model (a custom id, or a provider without per-model tables). Only the
 * known-dangerous codex `max` is floored (to `xhigh`, which every codex model accepts); every
 * other string passes through and the provider CLI arbitrates.
 */
export const clampEffortToProvider = (effort: string, provider: AiProvider): string => {
  if (provider === 'openai-codex' && effort === 'max') return 'xhigh';
  return effort;
};

/**
 * Narrow an effort to what the row's MODEL accepts, using the catalog's per-model effort list
 * (`modelEffortLevels`). The provider CLIs hard-fail on a level the model doesn't support (Copilot
 * on any level for `claude-haiku-4.5`; Codex `max` on `gpt-5.5`), so this applies to an explicit
 * row effort too:
 *
 * - model has no effort dimension → `undefined` (no flag is sent);
 * - level supported → unchanged;
 * - level unsupported → the strongest supported level below it, else the weakest supported one;
 * - model or level unknown (custom id; opencode / grok / claude rows) → unchanged, the CLI arbitrates.
 */
export const clampEffortToModel = (effort: string, provider: AiProvider, model: string): string | undefined => {
  const levels = modelEffortLevels(provider, model);
  if (levels === undefined || levels.includes(effort)) return effort;
  if (levels.length === 0) return undefined;
  const rank = (level: string): number => (EFFORT_RANK as readonly string[]).indexOf(level);
  const requested = rank(effort);
  if (requested === -1) return effort;
  const below = levels.filter((level) => rank(level) !== -1 && rank(level) < requested);
  return below.at(-1) ?? levels[0];
};

/**
 * Floor an effort the operator did NOT pin on this row (global, shipped default, agent binding):
 * the model's own list when the catalog knows it, else the provider-level {@link clampEffortToProvider}.
 */
export const floorEffort = (effort: string, provider: AiProvider, model: string): string | undefined =>
  modelEffortLevels(provider, model) === undefined
    ? clampEffortToProvider(effort, provider)
    : clampEffortToModel(effort, provider, model);
