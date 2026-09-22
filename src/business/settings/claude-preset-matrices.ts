import type { AiSettings } from '@src/domain/entity/settings.ts';
import { CLAUDE, OPUS, SONNET } from '@src/business/settings/preset-model-ids.ts';

/** Flagship on implement / plan / ideate; Sonnet on the lighter flows. */
export const CLAUDE_ONLY: AiSettings = {
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

/**
 * Claude's cheap tier is sonnet at `low`, not a smaller model. Effort is pinned on every
 * light row: unset would inherit this preset's global `high` and undo the saving.
 */
export const CLAUDE_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET, effort: 'low' },
  plan: { provider: CLAUDE, model: SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'high' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/**
 * Cheap sonnet author, permanently-opus critic. The generator climbs sonnet → opus on plateau,
 * so this preset assumes `escalateOnPlateau` is on. Light flows pin `low` so they do not
 * inherit the global `high`.
 */
export const CLAUDE_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/** Uniform Sonnet. Speed comes from `low` effort — Haiku 4.5 is retiring with no successor. */
export const CLAUDE_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CLAUDE, model: SONNET, effort: 'low' },
  plan: { provider: CLAUDE, model: SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'low' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/** Opus everywhere. Fable stays opt-in: it is 2.5× the Opus 5.5 price. */
export const CLAUDE_FRONTIER: AiSettings = {
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
