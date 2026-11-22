import type { AiSettings } from '@src/domain/entity/settings.ts';
import { GROK, GROK_FLAGSHIP } from '@src/business/settings/preset-model-ids.ts';

/*
 * Grok preset matrices. One file per provider; `presets.ts` is only the registry. Every row runs
 * `grok-4.7` (same price as 4.5 / 4.6, same speed as 4.6), so the families differ by effort only. Every row
 * pins an explicit effort, capped at `xhigh`, what `grok-4.7` accepts.
 */

export const GROK_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
};

/** Cost is bought back with effort: `high` on the deep flows, `medium` on the light ones. */
export const GROK_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
};

/** Author at `high` against an `xhigh` evaluator — the gate is split by effort, not model. */
export const GROK_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
};

/** Uniform `grok-4.7` at `low`. */
export const GROK_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'low' },
};

/** `grok-4.7` everywhere, `xhigh` (its ceiling) on the deep flows and ideate. `grok-4.7-build-fast` stays opt-in. */
export const GROK_FRONTIER: AiSettings = {
  effort: 'xhigh',
  refine: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  plan: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  implement: {
    generator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
    evaluator: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  },
  readiness: { provider: GROK, model: GROK_FLAGSHIP, effort: 'high' },
  ideate: { provider: GROK, model: GROK_FLAGSHIP, effort: 'xhigh' },
  createPr: { provider: GROK, model: GROK_FLAGSHIP, effort: 'medium' },
};
