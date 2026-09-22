import type { AiSettings } from '@src/domain/entity/settings.ts';
import { COPILOT, COPILOT_LUNA, COPILOT_OPUS, COPILOT_SONNET } from '@src/business/settings/preset-model-ids.ts';

/*
 * Copilot tiers: `gpt-5.6-luna` (light flows), `claude-sonnet-5`, and `claude-opus-4.8` on top.
 * Opus 5 / 5.5 are plan-gated on Copilot, so they stay pin-only and even the frontier preset
 * tops out at Opus 4.8. Every row pins an explicit effort.
 */

export const COPILOT_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET, effort: 'medium' },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  createPr: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
};

/** Sonnet 5 on the deep flows; the generator climbs Sonnet 5 → Opus 4.8 on plateau. */
export const COPILOT_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET, effort: 'medium' },
  createPr: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
};

/** Sonnet 5 author against an Opus 4.8 gate — one ladder rung apart. */
export const COPILOT_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET, effort: 'medium' },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  createPr: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
};

/** Sonnet 5 at `low` on plan / implement; luna at `low` everywhere else. */
export const COPILOT_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
  ideate: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
  createPr: { provider: COPILOT, model: COPILOT_LUNA, effort: 'low' },
};

/** Opus 4.8 everywhere, `max` on the deep flows. */
export const COPILOT_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  },
  readiness: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  createPr: { provider: COPILOT, model: COPILOT_OPUS, effort: 'medium' },
};
