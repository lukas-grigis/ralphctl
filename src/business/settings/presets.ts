import type { AiSettings, Settings } from '@src/domain/entity/settings.ts';

/**
 * Settings preset identifiers. Each preset is a one-shot snapshot of the AI section —
 * applying it stamps `ai.effort` plus all five per-flow rows. Preset identity is NOT
 * persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 *
 * Twenty shipped presets across five families (four each), all equally first-class — no preset
 * is marked "recommended" or "default". Each family carries a `mixed` variant plus one per
 * single provider, in that order. The families:
 *   standard      — `mixed` routes each flow to the best provider for that flow's purpose;
 *                   `<provider>-only` routes every flow to that one provider.
 *   economic      — mirror the standard routings but start `implement` one tier below the
 *                   flagship to save tokens, leaning on the escalation ladder to climb only when
 *                   a task plateaus.
 *   strong-gate   — cheap implement generator paired with a permanently-strong evaluator — the
 *                   only family that splits generator and evaluator onto different models.
 *   fast          — cheapest viable tier at `low` effort, optimising speed/cost over quality;
 *                   the only family with `escalateOnPlateau` stamped OFF so a plateau settles.
 *   frontier      — flagship everywhere at `max` effort (codex floored to `high`).
 *
 * Applying a preset stamps the AI section AND `harness.escalateOnPlateau`. Preset identity is
 * NOT persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 */
export type PresetName =
  | 'mixed'
  | 'claude-only'
  | 'copilot-only'
  | 'codex-only'
  | 'mixed-economic'
  | 'claude-economic'
  | 'copilot-economic'
  | 'codex-economic'
  | 'mixed-strong-gate'
  | 'claude-strong-gate'
  | 'copilot-strong-gate'
  | 'codex-strong-gate'
  | 'mixed-fast'
  | 'claude-fast'
  | 'copilot-fast'
  | 'codex-fast'
  | 'mixed-frontier'
  | 'claude-frontier'
  | 'copilot-frontier'
  | 'codex-frontier';

export const PRESET_NAMES: readonly PresetName[] = [
  'mixed',
  'claude-only',
  'copilot-only',
  'codex-only',
  'mixed-economic',
  'claude-economic',
  'copilot-economic',
  'codex-economic',
  'mixed-strong-gate',
  'claude-strong-gate',
  'copilot-strong-gate',
  'codex-strong-gate',
  'mixed-fast',
  'claude-fast',
  'copilot-fast',
  'codex-fast',
  'mixed-frontier',
  'claude-frontier',
  'copilot-frontier',
  'codex-frontier',
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

/**
 * `claude-strong-gate` — "strong gate, cheap generation." Mirrors `claude-economic`'s cheap
 * generation tiers but bumps `plan` and the implement EVALUATOR to the opus flagship: a cheap
 * sonnet author paired with a permanently-opus critic. It is the only preset that intentionally
 * SPLITS implement.generator and implement.evaluator onto different models (same `claude-code`
 * provider) — every other preset stamps one shared implement row.
 *
 * The generator starts on sonnet and climbs sonnet→opus on plateau via the default escalation
 * ladder, so this preset ASSUMES `settings.harness.escalateOnPlateau` (default true) is on —
 * without it a genuinely hard task can plateau-loop on the sonnet generator while the opus gate
 * keeps rejecting it, never escalating the author. The evaluator stays opus regardless: the gate
 * is strong from the first round, generation is cheap until a task proves it needs more.
 */
const CLAUDE_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  implement: {
    // Cheap author: sonnet at high effort, climbs to opus on plateau via the default ladder.
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
    // Strong gate: opus from the first round, never cheapened.
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  },
  readiness: { provider: 'claude-code', model: 'claude-haiku-4-5', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'claude-code', model: 'claude-haiku-4-5' },
};

/**
 * Strong-gate family — "strong gate, cheap generation." Mirrors the economic generation tiers
 * but bumps `plan` and the implement EVALUATOR to the provider flagship: a cheap author paired
 * with a permanently-strong critic. This is the only family that intentionally SPLITS
 * implement.generator and implement.evaluator onto different models (same provider) — every
 * other preset stamps one shared implement row.
 *
 * The generator starts a tier below flagship and climbs to it on plateau via the default
 * escalation ladder, so this family ASSUMES `escalateOnPlateau` (stamped true): without it a
 * genuinely hard task can plateau-loop on the cheap generator while the strong gate keeps
 * rejecting it, never escalating the author. The evaluator stays flagship regardless: the gate
 * is strong from the first round, generation is cheap until a task proves it needs more.
 *
 * Codex's `gpt-5.4`→`gpt-5.5` gate is the NARROWEST of the family — the two Codex tiers sit one
 * rung apart with a small capability gap, so the cheap author is already close to the gate.
 */
const MIXED_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'high' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'xhigh' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

const COPILOT_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: 'github-copilot', model: 'claude-sonnet-4.6' },
  plan: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'xhigh' },
  implement: {
    generator: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'high' },
    evaluator: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'xhigh' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'medium' },
  ideate: { provider: 'github-copilot', model: 'claude-sonnet-4.6' },
  createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
};

const CODEX_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  plan: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  implement: {
    // Narrowest gate of the family: gpt-5.4 author climbs the single rung to the gpt-5.5 gate.
    generator: { provider: 'openai-codex', model: 'gpt-5.4', effort: 'high' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'medium' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

/**
 * Fast family — cheapest viable tier at LOW effort across the board: speed and cost over
 * quality. This is the only family with `escalateOnPlateau` stamped OFF — a plateau here settles
 * (done-with-warning) rather than climbing the ladder, because the whole point is to stay cheap.
 *
 * Implement deliberately uses sonnet / gpt-mini, NOT haiku: haiku (and the codex nano tier) is
 * too weak to author code reliably, so the cheapest model that can still complete a task gates
 * the implement rows even in the fast family. Light flows (refine / readiness / ideate / createPr)
 * drop further — `codex-fast` leans on `minimal` effort for those light flows where Codex offers
 * a cheaper-than-low rung.
 */
const MIXED_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  plan: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'low' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'low' },
    evaluator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'low' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'low' },
  ideate: { provider: 'claude-code', model: 'claude-haiku-4-5' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
};

const CLAUDE_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: 'claude-code', model: 'claude-haiku-4-5' },
  plan: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'low' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'low' },
    evaluator: { provider: 'claude-code', model: 'claude-sonnet-4-6', effort: 'low' },
  },
  readiness: { provider: 'claude-code', model: 'claude-haiku-4-5', effort: 'low' },
  ideate: { provider: 'claude-code', model: 'claude-haiku-4-5' },
  createPr: { provider: 'claude-code', model: 'claude-haiku-4-5' },
};

const COPILOT_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: 'github-copilot', model: 'gpt-5-mini' },
  plan: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'low' },
  implement: {
    generator: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'low' },
    evaluator: { provider: 'github-copilot', model: 'claude-sonnet-4.6', effort: 'low' },
  },
  readiness: { provider: 'github-copilot', model: 'gpt-5-mini', effort: 'low' },
  ideate: { provider: 'github-copilot', model: 'gpt-5-mini' },
  createPr: { provider: 'github-copilot', model: 'gpt-5-mini' },
};

const CODEX_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
  plan: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' },
  implement: {
    generator: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'low' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.4-mini', effort: 'minimal' },
};

/**
 * Frontier family — flagship everywhere at MAX effort: quality over cost, every flow on the
 * strongest model. Codex is floored to `high` (its effort ceiling — global `ai.effort` stays
 * `high` on `codex-frontier` so nothing implies a `max` codex row, which the schema would reject).
 *
 * The family tops out at opus. `claude-fable-5` is intentionally NOT referenced even though it
 * is the catalog tier above opus: it is export-control-suspended and would be rejected at launch,
 * so the flagship-everywhere story stops at opus. Restoring fable when the suspension lifts is a
 * one-line model swap on the implement / plan rows here.
 */
const MIXED_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: 'openai-codex', model: 'gpt-5.5' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
  },
  readiness: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'high' },
  ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.5' },
};

const CLAUDE_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: 'claude-code', model: 'claude-opus-4-8' },
  plan: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
  implement: {
    generator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
    evaluator: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'max' },
  },
  readiness: { provider: 'claude-code', model: 'claude-opus-4-8', effort: 'high' },
  ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
  createPr: { provider: 'claude-code', model: 'claude-opus-4-8' },
};

const COPILOT_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: 'github-copilot', model: 'claude-opus-4.8' },
  plan: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'max' },
  implement: {
    generator: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'max' },
    evaluator: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'max' },
  },
  readiness: { provider: 'github-copilot', model: 'claude-opus-4.8', effort: 'high' },
  ideate: { provider: 'github-copilot', model: 'claude-opus-4.8' },
  createPr: { provider: 'github-copilot', model: 'claude-opus-4.8' },
};

const CODEX_FRONTIER: AiSettings = {
  // Codex ceiling — global stays `high` so nothing implies a `max` codex row.
  effort: 'high',
  refine: { provider: 'openai-codex', model: 'gpt-5.5' },
  plan: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  implement: {
    generator: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
    evaluator: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  },
  readiness: { provider: 'openai-codex', model: 'gpt-5.5', effort: 'high' },
  ideate: { provider: 'openai-codex', model: 'gpt-5.5' },
  createPr: { provider: 'openai-codex', model: 'gpt-5.5' },
};

/**
 * Each preset carries its AI matrix plus the `escalateOnPlateau` flag {@link applyPreset} stamps
 * onto `harness`. Standard / economic / strong-gate / frontier families want the escalation
 * ladder on; the fast family stamps it OFF so a plateau settles instead of climbing.
 */
const PRESETS: Readonly<Record<PresetName, { ai: AiSettings; escalateOnPlateau: boolean }>> = {
  mixed: { ai: MIXED, escalateOnPlateau: true },
  'claude-only': { ai: CLAUDE_ONLY, escalateOnPlateau: true },
  'copilot-only': { ai: COPILOT_ONLY, escalateOnPlateau: true },
  'codex-only': { ai: CODEX_ONLY, escalateOnPlateau: true },
  'mixed-economic': { ai: MIXED_ECONOMIC, escalateOnPlateau: true },
  'claude-economic': { ai: CLAUDE_ECONOMIC, escalateOnPlateau: true },
  'copilot-economic': { ai: COPILOT_ECONOMIC, escalateOnPlateau: true },
  'codex-economic': { ai: CODEX_ECONOMIC, escalateOnPlateau: true },
  'mixed-strong-gate': { ai: MIXED_STRONG_GATE, escalateOnPlateau: true },
  'claude-strong-gate': { ai: CLAUDE_STRONG_GATE, escalateOnPlateau: true },
  'copilot-strong-gate': { ai: COPILOT_STRONG_GATE, escalateOnPlateau: true },
  'codex-strong-gate': { ai: CODEX_STRONG_GATE, escalateOnPlateau: true },
  'mixed-fast': { ai: MIXED_FAST, escalateOnPlateau: false },
  'claude-fast': { ai: CLAUDE_FAST, escalateOnPlateau: false },
  'copilot-fast': { ai: COPILOT_FAST, escalateOnPlateau: false },
  'codex-fast': { ai: CODEX_FAST, escalateOnPlateau: false },
  'mixed-frontier': { ai: MIXED_FRONTIER, escalateOnPlateau: true },
  'claude-frontier': { ai: CLAUDE_FRONTIER, escalateOnPlateau: true },
  'copilot-frontier': { ai: COPILOT_FRONTIER, escalateOnPlateau: true },
  'codex-frontier': { ai: CODEX_FRONTIER, escalateOnPlateau: true },
};

/**
 * Stamp a preset onto `current`. The AI section is replaced wholesale with the preset's matrix,
 * and `harness.escalateOnPlateau` is overwritten with the preset's flag (fast family OFF, all
 * others ON). The REST of `harness` (maxTurns, escalationMap, plateauThreshold, …) plus
 * `logging`, `concurrency`, `ui`, `developer`, and `schemaVersion` are preserved verbatim. Pure
 * — does not touch persistence.
 *
 * Re-applying a preset clobbers any per-row customizations. No stored preset identity is
 * created, so a subsequent edit to any individual row sticks across reloads.
 */
export const applyPreset = (name: PresetName, current: Settings): Settings => {
  const preset = PRESETS[name];
  return {
    ...current,
    ai: preset.ai,
    harness: { ...current.harness, escalateOnPlateau: preset.escalateOnPlateau },
  };
};
