import type { AiSettings } from '@src/domain/entity/settings.ts';
import { CODEX, GPT_5_6_LUNA, GPT_5_6_SOL, GPT_5_6_TERRA } from '@src/business/settings/preset-model-ids.ts';

export const CODEX_ONLY: AiSettings = {
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

export const CODEX_ECONOMIC: AiSettings = {
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

/** Narrowest gate in the family: terra climbs the single default-ladder rung to sol. */
export const CODEX_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  implement: {
    generator: { provider: CODEX, model: GPT_5_6_TERRA, effort: 'high' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: CODEX, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CODEX, model: GPT_5_6_SOL },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/**
 * Uniform luna. Light flows leave effort unset so they inherit the global `low` — Codex no
 * longer has a below-`low` rung (`minimal` was retired).
 */
export const CODEX_FAST: AiSettings = {
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
 * Sol everywhere at `max`. Unset rows inherit the global `max`, which the codex clamp floors
 * to `xhigh` at resolve time. `ultra` is plan-gated and is not stamped.
 */
export const CODEX_FRONTIER: AiSettings = {
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
