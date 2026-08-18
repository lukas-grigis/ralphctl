import type { AiSettings, Settings } from '@src/domain/entity/settings.ts';

/**
 * Settings preset identifiers. Each preset is a one-shot snapshot of the AI section —
 * applying it stamps `ai.effort` plus all five per-flow rows. Preset identity is NOT
 * persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 *
 * Twenty-one shipped presets across five families (four each, plus `opencode-only` in the standard
 * family), all equally first-class — no preset is marked "recommended" or "default". Each family
 * carries a `mixed` variant plus one per single provider, in that order. The families:
 *   standard      — `mixed` routes each flow to the best provider for that flow's purpose;
 *                   `<provider>-only` routes every flow to that one provider.
 *   economic      — mirror the standard routings but start `implement` one tier below the
 *                   flagship to save tokens, leaning on the escalation ladder to climb only when
 *                   a task plateaus.
 *   strong-gate   — cheap implement generator paired with a permanently-strong evaluator — the
 *                   only family that splits generator and evaluator by TIER (`mixed` and
 *                   `mixed-frontier` split by provider, at the same tier).
 *   fast          — cheapest viable tier at `low` effort, optimising speed/cost over quality;
 *                   the only family with `escalateOnPlateau` stamped OFF so a plateau settles.
 *   frontier      — flagship everywhere at `max` effort (tops out at Opus 5 / GPT-5.6 Sol; codex
 *                   is no longer floored — the 5.6 flagship accepts `max` directly).
 *
 * Applying a preset stamps the AI section AND `harness.escalateOnPlateau` — plus, for the economic
 * family only, `harness.bestOfNCandidates: 0` (its explicit cost opt-out). Preset identity is
 * NOT persisted; the next per-row edit sticks and nothing remembers which preset was applied.
 */
export type PresetName =
  | 'mixed'
  | 'claude-only'
  | 'copilot-only'
  | 'codex-only'
  | 'opencode-only'
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
  'opencode-only',
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

// Provider and model identifiers referenced across the preset matrices below, hoisted so each
// literal appears once. The dash vs dot spelling is provider-specific and load-bearing:
// claude-code uses the dash form (`claude-opus-5`, `claude-sonnet-5` → OPUS / SONNET / HAIKU)
// while github-copilot uses the dotted form (`claude-…-4.8` → COPILOT_OPUS / COPILOT_SONNET). Do
// not normalise one into the other. Sonnet 5 is the default Sonnet for Claude Code; Copilot's
// curated presets stay on Sonnet 4.6 (its slug collides with the Claude-Code id — see escalation-map).
// `COPILOT_OPUS` deliberately stays `claude-opus-4.8` — `claude-opus-5` is plan-gated on Copilot
// (Pro+/Max/Business/Enterprise), so steering the curated Copilot presets there would brick spawns
// on lower plans; `claude-opus-5` is catalog + pin-only on Copilot. Like `claude-sonnet-5`,
// `claude-opus-5` is an undotted shared-slug id — identical on both the Claude-Code and Copilot
// catalogs — see escalation-map.ts.
const CLAUDE = 'claude-code';
const COPILOT = 'github-copilot';
const CODEX = 'openai-codex';
const OPENCODE = 'opencode';
/** OpenCode free-tier picks — see the note on OPENCODE_ONLY. */
const OPENCODE_BIG = 'opencode/big-pickle';
// The free tier rotates and individual ids go dark upstream (a 401 on one model while its
// siblings answer fine). Both picks here were live-probed against opencode-ai v1.18.15 on
// 2026-08-08; re-probe with `opencode models` before changing them.
const OPENCODE_MINI = 'opencode/deepseek-v4-flash-free';
const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5';
const COPILOT_OPUS = 'claude-opus-4.8';
const COPILOT_SONNET = 'claude-sonnet-4.6';
const GPT_5_6_SOL = 'gpt-5.6-sol';
const GPT_5_6_TERRA = 'gpt-5.6-terra';
// Cheap-tier pick for BOTH codex and copilot rows — `gpt-5.4-mini` retires 2026-08-31 and
// `gpt-5-mini` is the generation below it; `gpt-5.6-luna` is the 5.6 family's cost tier and is
// catalogued on both providers. It carries a live ladder rung (luna → terra) for the presets
// that escalate.
const GPT_5_6_LUNA = 'gpt-5.6-luna';

/**
 * The `mixed` preset matrix — best-of-breed across the three providers. Effort pattern:
 * `implement` and `plan` at `xhigh` for the deeper-reasoning autonomous flows; `readiness`
 * at `medium` (read-only inventory, no deep reasoning needed); `refine` and `ideate` leave
 * effort unset so they inherit the global `high`. Global `ai.effort` is stamped to `high`.
 *
 * Implement stamps the same row on both generator and evaluator — with one exception per family:
 * `mixed` and `mixed-frontier` pair a Claude Opus generator with a Codex `gpt-5.6-sol` evaluator,
 * mirroring the cross-provider split shipped in `DEFAULT_SETTINGS` (an independent second
 * opinion is the whole point of the mixed story). Everywhere else, splitting roles across
 * providers is configured explicitly by editing one of the role keys, not by a preset.
 */
const MIXED: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_TERRA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
    // Independent gate: a different provider's flagship grades the Opus author's work.
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS },
  // PR content drafting mirrors refine's "light summary" reasoning profile — a fast Codex
  // model is fine, no need to pay for Opus tokens just to summarise a diff.
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/**
 * Single-provider presets — every flow routed to one provider. The model picks per
 * provider follow the post-catalog-refresh tiers:
 *   implement / plan / ideate → deep-reasoning (provider's top-tier coder model)
 *   readiness → light (cheap, single-shot)
 *   refine → mid-tier
 *
 * Effort matrix mirrors Mixed: `implement` and `plan` at `xhigh` (Codex now accepts `xhigh` on
 * every catalog model — the vocabulary no longer floors it), `readiness` at `medium`,
 * `refine` and `ideate` inherit global `high`. Implement.generator and implement.evaluator
 * share the same row — the preset story is "every flow on this provider".
 */
const CLAUDE_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS },
  createPr: { provider: CLAUDE, model: SONNET },
};

const COPILOT_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

/**
 * OpenCode's zero-auth free tier. Unlike the other three providers this family has exactly ONE
 * member rather than the usual economic / strong-gate / fast / frontier spread: every free-tier
 * model sits at the same (zero) price point, so a "save money" or "spend for frontier quality"
 * variant would differ in name only. An operator who authenticates an upstream provider through
 * `opencode providers` should pin rows directly rather than reach for a preset.
 *
 * Effort is deliberately left unset on every row — OpenCode forwards it to `--variant`, whose
 * accepted values come from the upstream provider, and the free-tier community models generally
 * expose none. Omitting it lets the CLI use each model's own default instead of rejecting a
 * level the model never supported.
 */
const OPENCODE_ONLY: AiSettings = {
  refine: { provider: OPENCODE, model: OPENCODE_MINI },
  plan: { provider: OPENCODE, model: OPENCODE_BIG },
  implement: {
    generator: { provider: OPENCODE, model: OPENCODE_BIG },
    evaluator: { provider: OPENCODE, model: OPENCODE_BIG },
  },
  readiness: { provider: OPENCODE, model: OPENCODE_MINI },
  ideate: { provider: OPENCODE, model: OPENCODE_BIG },
  createPr: { provider: OPENCODE, model: OPENCODE_MINI },
};

const CODEX_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_TERRA },
  plan: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  implement: {
    generator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_5_6_SOL },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
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
 * tier too, in every family including `codex-economic` — the GPT-5.6 family's `terra` tier is
 * the intermediate tier the cheap-ideation row needed.
 *
 * This is also the one family that pins `harness.bestOfNCandidates` to `0` (see {@link PRESETS}).
 * The shipped default is `2` — a stuck task samples two candidates at the top of the ladder — but
 * that granted attempt spends N generator sessions instead of one, which is exactly the trade this
 * family exists to refuse. Every other family leaves the knob at whatever the operator has set.
 */
const MIXED_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'high' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

const CLAUDE_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: HAIKU },
  plan: { provider: CLAUDE, model: SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'high' },
  },
  readiness: { provider: CLAUDE, model: HAIKU, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CLAUDE, model: HAIKU },
};

const COPILOT_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

const CODEX_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CODEX, model: GPT_5_6_TERRA, effort: 'high' },
  implement: {
    generator: { provider: CODEX, model: GPT_5_6_TERRA, effort: 'high' },
    evaluator: { provider: CODEX, model: GPT_5_6_TERRA, effort: 'high' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_5_6_TERRA },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/**
 * `claude-strong-gate` — "strong gate, cheap generation." Mirrors `claude-economic`'s cheap
 * generation tiers but bumps `plan` and the implement EVALUATOR to the opus flagship: a cheap
 * sonnet author paired with a permanently-opus critic. It is the only preset that intentionally
 * SPLITS implement.generator and implement.evaluator onto different TIERS (same `claude-code`
 * provider) — every other preset stamps one shared implement row, apart from `mixed` /
 * `mixed-frontier`, which keep one tier but route the evaluator to a different provider.
 *
 * The generator starts on sonnet and climbs sonnet→opus on plateau via the default escalation
 * ladder, so this preset ASSUMES `settings.harness.escalateOnPlateau` (default true) is on —
 * without it a genuinely hard task can plateau-loop on the sonnet generator while the opus gate
 * keeps rejecting it, never escalating the author. The evaluator stays opus regardless: the gate
 * is strong from the first round, generation is cheap until a task proves it needs more.
 */
const CLAUDE_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    // Cheap author: sonnet at high effort, climbs to opus on plateau via the default ladder.
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    // Strong gate: opus from the first round, never cheapened.
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: HAIKU, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CLAUDE, model: HAIKU },
};

/**
 * Strong-gate family — "strong gate, cheap generation." Mirrors the economic generation tiers
 * but bumps `plan` and the implement EVALUATOR to the provider flagship: a cheap author paired
 * with a permanently-strong critic. This is the only family that intentionally SPLITS
 * implement.generator and implement.evaluator onto different TIERS (same provider) — every
 * other preset stamps one shared implement row, apart from `mixed` / `mixed-frontier`, which
 * keep one tier but route the evaluator to a different provider.
 *
 * The generator starts a tier below flagship and climbs to it on plateau via the default
 * escalation ladder, so this family ASSUMES `escalateOnPlateau` (stamped true): without it a
 * genuinely hard task can plateau-loop on the cheap generator while the strong gate keeps
 * rejecting it, never escalating the author. The evaluator stays flagship regardless: the gate
 * is strong from the first round, generation is cheap until a task proves it needs more.
 *
 * Codex's `gpt-5.6-terra`→`gpt-5.6-sol` gate is the NARROWEST of the family — the two Codex
 * tiers sit one rung apart with a small capability gap, so the cheap author is already close
 * to the gate.
 */
const MIXED_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

const COPILOT_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

const CODEX_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  implement: {
    // Narrowest gate of the family: terra author climbs the single default-ladder rung to the
    // sol gate.
    generator: { provider: CODEX, model: GPT_5_6_TERRA, effort: 'high' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_5_6_SOL },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/**
 * Fast family — cheapest viable tier at LOW effort across the board: speed and cost over
 * quality. This is the only family with `escalateOnPlateau` stamped OFF — a plateau here settles
 * (done-with-warning) rather than climbing the ladder, because the whole point is to stay cheap.
 *
 * Implement deliberately uses sonnet / gpt-mini, NOT haiku: haiku (and the codex nano tier) is
 * too weak to author code reliably, so the cheapest model that can still complete a task gates
 * the implement rows even in the fast family. Light flows (refine / readiness / ideate / createPr)
 * drop further — `codex-fast`'s light flows leave `effort` unset so they inherit the family's
 * global `low`; Codex no longer has a below-`low` rung (`minimal` was retired).
 */
const MIXED_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'low' },
  ideate: { provider: CLAUDE, model: HAIKU },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

const CLAUDE_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CLAUDE, model: HAIKU },
  plan: { provider: CLAUDE, model: SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: CLAUDE, model: HAIKU, effort: 'low' },
  ideate: { provider: CLAUDE, model: HAIKU },
  createPr: { provider: CLAUDE, model: HAIKU },
};

const COPILOT_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: COPILOT, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'low' },
  ideate: { provider: COPILOT, model: GPT_5_6_LUNA },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

const CODEX_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'low' },
  implement: {
    generator: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'low' },
    evaluator: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'low' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_LUNA },
  ideate: { provider: CODEX, model: GPT_5_6_LUNA },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/**
 * Frontier family — flagship everywhere at MAX effort: quality over cost, every flow on the
 * strongest model. Codex is no longer floored: the GPT-5.6 flagship (`gpt-5.6-sol`) accepts
 * `max`, so `codex-frontier` stamps the global effort AND the plan/implement rows at `max`
 * directly (readiness stays `high`; refine/ideate/createPr leave effort unset and inherit the
 * global `max`, which the codex provider clamp floors to `xhigh` at resolve time). `ultra` is
 * deliberately NOT stamped anywhere in this family — it is plan-gated to Plus+ and would brick
 * spawns on lower plans; operators opt in per-row.
 *
 * The family tops out at Opus 5 / GPT-5.6 Sol. `claude-fable-5` is intentionally NOT referenced
 * even though it is the catalog tier above Opus 5: Fable is 2x the Opus price, an operator spend
 * decision rather than a flagship default, so the flagship-everywhere story stops at Opus 5.
 * Opting in is a one-line model swap on the implement / plan rows here, or an `escalationMap`
 * rung (`'claude-opus-5': 'claude-fable-5'`).
 */
const MIXED_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CODEX, model: GPT_5_6_SOL },
  plan: { provider: CLAUDE, model: OPUS, effort: 'max' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'max' },
    // Same cross-provider gate as `mixed`, at the frontier tier.
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'max' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: OPUS },
  createPr: { provider: CODEX, model: GPT_5_6_SOL },
};

const CLAUDE_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CLAUDE, model: OPUS },
  plan: { provider: CLAUDE, model: OPUS, effort: 'max' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'max' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'max' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: OPUS },
  createPr: { provider: CLAUDE, model: OPUS },
};

const COPILOT_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: COPILOT, model: COPILOT_OPUS },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  },
  readiness: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS },
  createPr: { provider: COPILOT, model: COPILOT_OPUS },
};

const CODEX_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CODEX, model: GPT_5_6_SOL },
  plan: { provider: CODEX, model: GPT_5_6_SOL, effort: 'max' },
  implement: {
    generator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'max' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'max' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_SOL, effort: 'high' },
  ideate: { provider: CODEX, model: GPT_5_6_SOL },
  createPr: { provider: CODEX, model: GPT_5_6_SOL },
};

/**
 * Each preset carries its AI matrix plus the `escalateOnPlateau` flag {@link applyPreset} stamps
 * onto `harness`. Standard / economic / strong-gate / frontier families want the escalation
 * ladder on; the fast family stamps it OFF so a plateau settles instead of climbing.
 *
 * `bestOfNCandidates` is OPTIONAL here and stamped only where a preset takes a position on it: the
 * four economic presets pin `0` (their whole story is refusing the N× generator spend of a granted
 * best-of-N attempt, and the shipped default is now `2`). Every other preset omits it, so applying
 * one leaves the operator's current value alone.
 */
const PRESETS: Readonly<
  Record<PresetName, { ai: AiSettings; escalateOnPlateau: boolean; bestOfNCandidates?: number }>
> = {
  mixed: { ai: MIXED, escalateOnPlateau: true },
  'claude-only': { ai: CLAUDE_ONLY, escalateOnPlateau: true },
  'copilot-only': { ai: COPILOT_ONLY, escalateOnPlateau: true },
  'codex-only': { ai: CODEX_ONLY, escalateOnPlateau: true },
  'opencode-only': { ai: OPENCODE_ONLY, escalateOnPlateau: true },
  'mixed-economic': { ai: MIXED_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'claude-economic': { ai: CLAUDE_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'copilot-economic': { ai: COPILOT_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
  'codex-economic': { ai: CODEX_ECONOMIC, escalateOnPlateau: true, bestOfNCandidates: 0 },
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
 * `harness.escalateOnPlateau` is overwritten with the preset's flag (fast family OFF, all others
 * ON), and `harness.bestOfNCandidates` is overwritten ONLY by the presets that declare one (the
 * economic family, which pins `0`). The REST of `harness` (maxTurns, escalationMap,
 * plateauThreshold, …) plus `logging`, `concurrency`, `ui`, and `schemaVersion` are
 * preserved verbatim. Pure — does not touch persistence.
 *
 * Re-applying a preset clobbers any per-row customizations. No stored preset identity is
 * created, so a subsequent edit to any individual row sticks across reloads.
 */
export const applyPreset = (name: PresetName, current: Settings): Settings => {
  const preset = PRESETS[name];
  return {
    ...current,
    ai: preset.ai,
    harness: {
      ...current.harness,
      escalateOnPlateau: preset.escalateOnPlateau,
      ...(preset.bestOfNCandidates !== undefined ? { bestOfNCandidates: preset.bestOfNCandidates } : {}),
    },
  };
};
