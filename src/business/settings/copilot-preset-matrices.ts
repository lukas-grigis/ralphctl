import type { AiSettings } from '@src/domain/entity/settings.ts';
import { COPILOT, COPILOT_OPUS, COPILOT_SONNET, GPT_5_6_LUNA } from '@src/business/settings/preset-model-ids.ts';

/** Opus 4.8 on the deep flows. Opus 5 is plan-gated on Copilot, so it stays pin-only. */
export const COPILOT_ONLY: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

export const COPILOT_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

export const COPILOT_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: COPILOT, model: COPILOT_SONNET },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: COPILOT, model: COPILOT_SONNET },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

export const COPILOT_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: COPILOT, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
    evaluator: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'low' },
  ideate: { provider: COPILOT, model: GPT_5_6_LUNA },
  createPr: { provider: COPILOT, model: GPT_5_6_LUNA },
};

export const COPILOT_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: COPILOT, model: COPILOT_OPUS },
  plan: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  implement: {
    generator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
    evaluator: { provider: COPILOT, model: COPILOT_OPUS, effort: 'max' },
  },
  readiness: { provider: COPILOT, model: COPILOT_OPUS, effort: 'high' },
  ideate: { provider: COPILOT, model: COPILOT_OPUS },
  createPr: { provider: COPILOT, model: COPILOT_OPUS },
};
