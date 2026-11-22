import type { AiSettings } from '@src/domain/entity/settings.ts';
import { CLAUDE, FABLE, HAIKU, OPUS, SONNET } from '@src/business/settings/preset-model-ids.ts';

/*
 * Every row pins an explicit effort. An unset row would fall back to the preset's global effort,
 * and Opus 5.5's own CLI default is only `medium` — neither is what a curated matrix means.
 */

/** Opus 5.5 on implement / plan / ideate; Sonnet on the lighter flows. */
export const CLAUDE_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS, effort: 'high' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/**
 * Sonnet on the deep flows, Haiku 5.5 on the light ones (`medium` on refine / readiness, `low` on createPr).
 * The generator climbs Sonnet 5.5 → Opus 5.5 on plateau, so a hard task still reaches the
 * {@link CLAUDE_ONLY} flagship.
 */
export const CLAUDE_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: HAIKU, effort: 'medium' },
  plan: { provider: CLAUDE, model: SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'high' },
  },
  readiness: { provider: CLAUDE, model: HAIKU, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  createPr: { provider: CLAUDE, model: HAIKU, effort: 'low' },
};

/**
 * Cheap Sonnet author, permanently-Opus critic. The generator climbs Sonnet 5.5 → Opus 5.5 on
 * plateau, so this preset assumes `escalateOnPlateau` is on.
 */
export const CLAUDE_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  plan: { provider: CLAUDE, model: OPUS, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: CLAUDE, model: SONNET, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'high' },
  createPr: { provider: CLAUDE, model: SONNET, effort: 'low' },
};

/**
 * Everything at `low`: Haiku 5.5 on the light flows (refine / readiness / createPr), Sonnet 5.5 on
 * plan / implement / ideate so the generator stays code-capable.
 */
export const CLAUDE_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CLAUDE, model: HAIKU, effort: 'low' },
  plan: { provider: CLAUDE, model: SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: CLAUDE, model: HAIKU, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'low' },
  createPr: { provider: CLAUDE, model: HAIKU, effort: 'low' },
};

/**
 * No cost ceiling: Fable 5.2, Anthropic's flagship above Opus, on the deep flows (plan /
 * implement / ideate) and Opus 5.5 on the light ones. Fable needs 30-day data retention — a
 * zero-data-retention org gets a 400, so such orgs should use {@link CLAUDE_ONLY} instead. Fable has no
 * model rung above it; a plateau climbs the effort rung instead (high→xhigh→max).
 */
export const CLAUDE_FRONTIER: AiSettings = {
  effort: 'high',
  refine: { provider: CLAUDE, model: OPUS, effort: 'high' },
  plan: { provider: CLAUDE, model: FABLE, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: FABLE, effort: 'high' },
    evaluator: { provider: CLAUDE, model: FABLE, effort: 'high' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: FABLE, effort: 'high' },
  createPr: { provider: CLAUDE, model: OPUS, effort: 'medium' },
};
