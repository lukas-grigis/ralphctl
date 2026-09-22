import type { AiSettings } from '@src/domain/entity/settings.ts';
import {
  CLAUDE,
  CODEX,
  COPILOT,
  COPILOT_SONNET,
  GPT_5_6_LUNA,
  GPT_5_6_SOL,
  GPT_5_6_TERRA,
  OPUS,
  SONNET,
} from '@src/business/settings/preset-model-ids.ts';

/**
 * Best-of-breed across providers. `implement` and `plan` at `xhigh`; `readiness` at `medium`;
 * `refine` and `ideate` inherit the global `high`.
 *
 * `mixed` and `mixed-frontier` pair a Claude Opus generator with a Codex `gpt-5.6-sol`
 * evaluator, mirroring `DEFAULT_SETTINGS`. An independent second opinion is the point.
 * Everywhere else, splitting roles across providers is a per-row edit, not a preset.
 */
export const MIXED: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_TERRA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: OPUS },
  // Summarising a diff does not need Opus tokens.
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

export const MIXED_ECONOMIC: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'high' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'high' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

export const MIXED_STRONG_GATE: AiSettings = {
  effort: 'high',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'high' },
    evaluator: { provider: CLAUDE, model: OPUS, effort: 'xhigh' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'medium' },
  ideate: { provider: CLAUDE, model: SONNET },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

export const MIXED_FAST: AiSettings = {
  effort: 'low',
  refine: { provider: CODEX, model: GPT_5_6_LUNA },
  plan: { provider: COPILOT, model: COPILOT_SONNET, effort: 'low' },
  implement: {
    generator: { provider: CLAUDE, model: SONNET, effort: 'low' },
    evaluator: { provider: CLAUDE, model: SONNET, effort: 'low' },
  },
  readiness: { provider: COPILOT, model: GPT_5_6_LUNA, effort: 'low' },
  ideate: { provider: CLAUDE, model: SONNET, effort: 'low' },
  createPr: { provider: CODEX, model: GPT_5_6_LUNA },
};

/** Same cross-provider gate as {@link MIXED}, at the frontier tier. */
export const MIXED_FRONTIER: AiSettings = {
  effort: 'max',
  refine: { provider: CODEX, model: GPT_5_6_SOL },
  plan: { provider: CLAUDE, model: OPUS, effort: 'max' },
  implement: {
    generator: { provider: CLAUDE, model: OPUS, effort: 'max' },
    evaluator: { provider: CODEX, model: GPT_5_6_SOL, effort: 'max' },
  },
  readiness: { provider: CLAUDE, model: OPUS, effort: 'high' },
  ideate: { provider: CLAUDE, model: OPUS },
  createPr: { provider: CODEX, model: GPT_5_6_SOL },
};
