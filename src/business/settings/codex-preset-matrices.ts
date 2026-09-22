import type { AiSettings } from '@src/domain/entity/settings.ts';
import { CODEX, GPT_6_ASTRA, GPT_6_LUNA, GPT_6_SOL } from '@src/business/settings/preset-model-ids.ts';

/*
 * GPT-6 family throughout: `gpt-6-luna` (cheap), `gpt-6-sol` (flagship, top of the Codex ladder),
 * `gpt-6-astra` (premium, 5x sol — frontier only). Every row pins an explicit effort so nothing
 * falls back to the preset's global or the codex CLI's per-model default. `ultra` is plan-gated
 * and luna does not accept it, so no row stamps it.
 */

export const CODEX_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'high' },
  plan: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
  implement: {
    generator: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_6_SOL, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/**
 * Luna everywhere, bought back with effort: `gpt-6-luna` at `xhigh` is reported to match
 * `gpt-5.6-sol` at roughly 1/20 of the sol price. The generator climbs luna → sol on plateau.
 */
export const CODEX_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  plan: { provider: CODEX, model: GPT_6_LUNA, effort: 'xhigh' },
  implement: {
    generator: { provider: CODEX, model: GPT_6_LUNA, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_6_LUNA, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  ideate: { provider: CODEX, model: GPT_6_LUNA, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/** Luna author at `xhigh` against a sol gate; luna climbs the single default-ladder rung to sol. */
export const CODEX_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  plan: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
  implement: {
    generator: { provider: CODEX, model: GPT_6_LUNA, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_6_SOL, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/** Uniform luna at `low` — Codex has no below-`low` rung (`minimal` was retired). */
export const CODEX_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  plan: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  implement: {
    generator: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
    evaluator: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  },
  readiness: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  ideate: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
  createPr: { provider: CODEX, model: GPT_6_LUNA, effort: 'low' },
};

/**
 * No cost ceiling: `gpt-6-astra` (premium tier, 5x the sol price, Plus-and-up plans) on the deep
 * flows and `gpt-6-sol` on the light ones. Astra is off the default ladder, so nothing escalates
 * from here.
 */
export const CODEX_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CODEX, model: GPT_6_SOL, effort: 'high' },
  plan: { provider: CODEX, model: GPT_6_ASTRA, effort: 'max' },
  implement: {
    generator: { provider: CODEX, model: GPT_6_ASTRA, effort: 'max' },
    evaluator: { provider: CODEX, model: GPT_6_ASTRA, effort: 'max' },
  },
  readiness: { provider: CODEX, model: GPT_6_SOL, effort: 'high' },
  ideate: { provider: CODEX, model: GPT_6_ASTRA, effort: 'high' },
  createPr: { provider: CODEX, model: GPT_6_SOL, effort: 'medium' },
};
