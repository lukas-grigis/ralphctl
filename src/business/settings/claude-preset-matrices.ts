import type { AiSettings } from '@src/domain/entity/settings.ts';
import { CLAUDE, FABLE, OPUS, SONNET } from '@src/business/settings/preset-model-ids.ts';

/*
 * Every row pins an explicit effort. An unset row would fall back to the preset's global effort,
 * and Opus 5.5's own CLI default is only `medium` — neither is what a curated matrix means.
 */

/** Opus 5.5 on implement / plan / ideate; Sonnet on the lighter flows. */
export const CLAUDE_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS, effort: 'high' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/**
 * Sonnet everywhere; the cheap tier is Sonnet at `low`, not a smaller model. The generator climbs
 * Sonnet 5 → Opus 5.5 on plateau, so a hard task still reaches the {@link CLAUDE_ONLY} flagship.
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
  ideate: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/**
 * Cheap Sonnet author, permanently-Opus critic. The generator climbs Sonnet 5 → Opus 5.5 on
 * plateau, so this preset assumes `escalateOnPlateau` is on.
 */
export const CLAUDE_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'high' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/** Uniform Sonnet at `low`. Speed comes from effort — Haiku 4.5 is retiring with no successor. */
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

/**
 * No cost ceiling: Fable 5.1, Anthropic's flagship above Opus, on the deep flows (plan /
 * implement / ideate) and Opus 5.5 on the light ones. Fable is 2.5x the Opus 5.5 price and needs
 * 30-day data retention — a zero-data-retention org gets a 400, so such orgs should use
 * {@link CLAUDE_ONLY} instead. Fable has no ladder rung above it, so nothing escalates from here.
 */
export const CLAUDE_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CLAUDE, model: OPUS, effort: 'high' },
  plan: { provider: CLAUDE, model: FABLE, effort: 'max' },
  implement: {
    generator: { provider: CLAUDE, model: FABLE, effort: 'max' },
    evaluator: { provider: CLAUDE, model: FABLE, effort: 'max' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: FABLE, effort: 'high' },
  createPr: { provider: CLAUDE, model: OPUS, effort: 'medium' },
};
