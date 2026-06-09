import type { AiSettings, Settings } from '@src/domain/entity/settings.ts';

/**
 * Settings preset identifiers. Each preset is a one-shot snapshot of the AI section —
 * applying it stamps `ai.effort` plus all five per-flow rows. Preset identity is NOT
 * persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 *
 * Eight shipped presets, all equally first-class — no preset is marked "recommended" or
 * "default". The four standard presets: `mixed` routes each flow to the best provider for that
 * flow's purpose; `<provider>-only` routes every flow to that one provider (the fully-supported
 * single-provider configuration). The four `*-economic` variants mirror those routings but
 * start `implement` one tier below the flagship to save tokens, leaning on the escalation
 * ladder to climb to the flagship only when a task plateaus.
 */
export type PresetName =
  | 'mixed'
  | 'claude-only'
  | 'copilot-only'
  | 'codex-only'
  | 'mixed-economic'
  | 'claude-economic'
  | 'copilot-economic'
  | 'codex-economic';

export const PRESET_NAMES: readonly PresetName[] = [
  'mixed',
  'claude-only',
  'copilot-only',
  'codex-only',
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
] as const;

export const isPresetName = (raw: string): raw is PresetName => (PRESET_NAMES as readonly string[]).includes(raw);

/**
 * The `mixed` preset matrix — best-of-breed across the three providers. Effort pattern:
 * `implement` and `plan` at `xhigh` for the deeper-reasoning autonomous flows; `readiness`
 * at `medium` (read-only inventory, no deep reasoning needed); `refine` and `ideate` leave
 * effort unset so they inherit the global `high`. Global `ai.effort` is stamped to `high`.
 *
 * Implement stamps the same row on both generator and evaluator — splitting roles across
 * providers is configured explicitly by editing one of the role keys, not by a preset.
 */
const MIXED: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.5' },
  plan: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'xhigh' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  // PR content drafting mirrors refine's "light summary" reasoning profile — a fast Codex
  // model is fine, no need to pay for Opus tokens just to summarise a diff.
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

/**
 * Single-provider presets — every flow routed to one provider. The model picks per
 * provider follow the post-catalog-refresh tiers:
 *   implement / plan / ideate → deep-reasoning (provider's top-tier coder model)
 *   readiness → light (cheap, single-shot)
 *   refine → mid-tier
 *
 * Effort matrix mirrors Mixed: `implement` and `plan` at `xhigh` (Codex floors `xhigh`
 * back to `high` at resolve time via the provider ceiling), `readiness` at `medium`,
 * `refine` and `ideate` inherit global `high`. Implement.generator and implement.evaluator
 * share the same row — the preset story is "every flow on this provider".
 */
const CLAUDE_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  },
  readiness: { provider: 'claude-code', model: 'claude-haiku-4-5', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  createPr: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
};

const COPILOT_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: 'github-copilot', model: 'claude-sonnet-4.6' },
  plan: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'xhigh' },
  implement: {
    generator: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'xhigh' },
    evaluator: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'xhigh' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'github-copilot', model: 'claude-opus-4.8' },
  createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
};

const CODEX_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.4' },
  plan: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  implement: {
    // gpt-5.3-codex is deprecated for ChatGPT sign-in — implement now rides the frontier
    // default so the everyday autonomous loop keeps working under ChatGPT auth.
    generator: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'medium' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

/**
 * Economic preset matrices — ADDITIONAL to the four standard presets above; they do not
 * replace them. Strategy: quality held, money saved. `implement` starts one tier BELOW the
 * provider's flagship at `high` effort (rather than at the flagship), the evaluator shares
 * that cheaper row, and `refine` / `readiness` / `ideate` / `createPr` route to the cheap
 * tier. This is safe because the redesigned escalation ladder climbs to the flagship only
 * when a task plateaus — so most tasks finish on the cheaper tier and only the genuinely hard
 * ones pay flagship token rates. Global `ai.effort` is stamped to `high` like the standard
 * presets; per-row efforts mirror the standard presets (`plan` / `implement` heavy, `readiness`
 * `medium`, `refine` / `ideate` inherit global). Implement.generator and implement.evaluator
 * share the same row — splitting roles is an explicit per-row edit, not a preset.
 *
 * `refine` / `readiness` / `createPr` drop to the cheap tier across all four; `ideate` drops a
 * tier too, EXCEPT `codex-economic` where it stays on `gpt-5.5` — Codex has no cheaper
 * coding-grade tier that suits single-shot ideation, so the row matches `codex-only`.
 */
const MIXED_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  plan: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'high' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
    evaluator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

const CLAUDE_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: 'claude-code', model: 'claude-haiku-4-5' },
  plan: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
    evaluator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
  },
  readiness: { provider: 'claude-code', model: 'claude-haiku-4-5', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'claude-code', model: 'claude-haiku-4-5' },
};

const COPILOT_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: 'github-copilot', model: 'gpt-5.4-mini' },
  plan: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'high' },
  implement: {
    generator: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'high' },
    evaluator: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'high' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'github-copilot', model: 'claude-sonnet-4.6' },
  createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
};

const CODEX_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  plan: { provider: 'openai-codex', model: 'gpt-5.4', effort: 'high' },
  implement: {
    generator: { provider: 'openai-codex', model: 'gpt-5.4', effort: 'high' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.4', effort: 'high' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'medium' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

const PRESETS: Readonly<Record<PresetName, AiSettings>> = {
  mixed: MIXED,
  'claude-only': CLAUDE_ONLY,
  'copilot-only': COPILOT_ONLY,
  'codex-only': CODEX_ONLY,
  'mixed-economic': MIXED_ECONOMIC,
  'claude-economic': CLAUDE_ECONOMIC,
  'copilot-economic': COPILOT_ECONOMIC,
  'codex-economic': CODEX_ECONOMIC,
};

/**
 * Stamp a preset onto `current`. The AI section is replaced wholesale with the preset's
 * matrix; `harness`, `logging`, `concurrency`, `ui`, `developer`, and `schemaVersion` are
 * preserved verbatim. Pure — does not touch persistence.
 *
 * Re-applying a preset clobbers any per-row customizations. No stored preset identity is
 * created, so a subsequent edit to any individual row sticks across reloads.
 */
export const applyPreset = (name: PresetName, current: Settings): Settings => ({
  ...current,
  ai: PRESETS[name],
});
