import type { AiSettings } from '@src/domain/entity/settings.ts';
import { GROK, GROK_CHEAP, GROK_FLAGSHIP, GROK_MID } from '@src/business/settings/preset-model-ids.ts';

/*
 * Grok preset matrices. One file per provider; `presets.ts` is only the registry. Tiers (cheap
 * `grok-4.5`, mid `grok-4.6`, flagship `grok-4.7`) are documented in `preset-model-ids.ts`.
 * Every row pins an explicit effort, with the same per-flow shape as the other providers.
 */

export const GROK_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_MID, effort: 'medium' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  createPr: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
};

/** Implement on the mid tier at `high`; light flows on the cheap tier. Climbs to {@link GROK_ONLY}. */
export const GROK_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  plan: { provider: GROK, model: GROK_MID, effort: 'high' },
  implement: {
    generator: { provider: GROK, model: GROK_MID, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_MID, effort: 'high' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_MID, effort: 'medium' },
  createPr: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
};

/** One-rung gate: a `grok-4.6` author climbs to a `grok-4.7` evaluator. */
export const GROK_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_MID, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  createPr: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
};

/** Uniform `grok-4.5` at `low`. It is still a full coding model, so implement stays on it. */
export const GROK_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  plan: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  implement: {
    generator: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
    evaluator: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  },
  readiness: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  ideate: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
  createPr: { provider: GROK, model: GROK_CHEAP, effort: 'low' },
};

/** `grok-4.7` everywhere, `max` on the deep flows. `grok-4.7-build-fast` stays opt-in. */
export const GROK_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'max' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
};
