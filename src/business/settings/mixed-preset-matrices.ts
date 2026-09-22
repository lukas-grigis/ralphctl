import type { AiSettings } from '@src/domain/entity/settings.ts';
import {
  CLAUDE,
  CODEX,
  COPILOT,
  COPILOT_LUNA,
  COPILOT_SONNET,
  FABLE,
  GPT_6_ASTRA,
  GPT_6_LUNA,
  GPT_6_SOL,
  OPUS,
  SONNET,
} from '@src/business/settings/preset-model-ids.ts';

/*
 * Best-of-breed across providers: Codex `gpt-6-luna` on the text-only flows (refine / createPr),
 * Copilot `gpt-5.6-luna` on readiness, Claude on plan / implement / ideate. Every row pins an
 * explicit effort.
 *
 * `mixed`, `mixed-economic` and `mixed-frontier` grade a Claude generator with a Codex evaluator,
 * mirroring `DEFAULT_SETTINGS` — an independent critic that does not share the author's blind
 * spots is the point. `mixed-strong-gate` keeps both roles on Claude (the family splits by tier)
 * and `mixed-fast` keeps both on Sonnet.
 */

export const MIXED: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'high' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS, effort: 'high' },
  // Summarising a diff does not need Opus tokens.
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/**
 * Sonnet author graded by a `gpt-6-luna` critic at `xhigh` — a cross-provider second opinion at
 * near-zero cost. The generator climbs Sonnet 5 → Opus 5.5 on plateau, reaching {@link MIXED}'s
 * flagship.
 */
export const MIXED_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CODEX, model: GPT_6_LUNA, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

export const MIXED_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

export const MIXED_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'low' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/**
 * Same cross-provider gate as {@link MIXED}, at the frontier tier: a Fable 5.1 author graded by
 * a `gpt-6-astra` critic. Both are their vendor's premium tier and opt-in only elsewhere; see
 * `CLAUDE_FRONTIER` / `CODEX_FRONTIER` for the cost and data-retention caveats.
 */
export const MIXED_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CODEX, model: GPT_6_SOL, effort: 'high' },
  plan: { provider: CLAUDE, model: FABLE, effort: 'max' },
  implement: {
    generator: { provider: CLAUDE, model: FABLE, effort: 'max' },
    evaluator: { provider: CODEX, model: GPT_6_ASTRA, effort: 'max' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: FABLE, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_SOL, effort: 'medium' },
};
