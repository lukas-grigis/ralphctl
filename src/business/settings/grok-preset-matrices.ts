import type { AiSettings } from '@src/domain/entity/settings.ts';

/**
 * Grok preset matrices. One file per provider; `presets.ts` is only the registry.
 *
 * Tiers match the Codex 5.6 family: cheap `grok-4.5`, mid `grok-4.6`, flagship `grok-4.7`.
 * Probed with `grok models` on grok 1.0.40 (2026-09-22). `grok-4.6` and `grok-4.7` publish the
 * same token price, so stepping off the flagship saves effort tokens, not a lower rate.
 * `grok-4.7-build-fast` is the same model at twice the price and is not a preset pick.
 */
const GROK = 'xai-grok';
const GROK_FLAGSHIP = 'grok-4.7';
const GROK_MID = 'grok-4.6';
const GROK_CHEAP = 'grok-4.5';

export const GROK_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_MID },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP },
  createPr: { provider: GROK, model: GROK_CHEAP },
};

/** Implement on the mid tier at `high`; light flows on the cheap tier. Climbs to {@link GROK_ONLY}. */
export const GROK_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_CHEAP },
  plan: { provider: GROK, model: GROK_MID, effort: 'high' },
  implement: {
    generator: { provider: GROK, model: GROK_MID, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_MID, effort: 'high' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_MID },
  createPr: { provider: GROK, model: GROK_CHEAP },
};

/** One-rung gate: a `grok-4.6` author climbs to a `grok-4.7` evaluator. */
export const GROK_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_CHEAP },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_MID, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP },
  createPr: { provider: GROK, model: GROK_CHEAP },
};

/** Uniform `grok-4.5` at `low`. It is still a full coding model, so implement stays on it. */
export const GROK_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: GROK, model: GROK_CHEAP },
  plan: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  implement: {
    generator: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
    evaluator: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP },
  ideate: { provider: GROK, model: GROK_CHEAP },
  createPr: { provider: GROK, model: GROK_CHEAP },
};

export const GROK_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: GROK, model: GROK_FLAGSHIP },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP },
  createPr: { provider: GROK, model: GROK_FLAGSHIP },
};
