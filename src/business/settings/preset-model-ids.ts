/**
 * Model ids shared by the preset matrices. Hoisted so each literal appears once.
 *
 * The dash vs dot spelling is provider-specific and load-bearing: claude-code uses the dash
 * form (`claude-opus-5-5`, `claude-sonnet-5`) while github-copilot uses the dotted form
 * (`claude-…-4.8`). Do not normalise one into the other. Sonnet 5 is the default Sonnet on both;
 * its undotted slug is the same string on either catalog, and the provider-scoped escalation
 * ladders (escalation-map.ts) climb it differently per backend. Copilot deprecated Sonnet 4.6 on
 * 2026-09-01, so `COPILOT_SONNET` is `claude-sonnet-5`.
 *
 * `COPILOT_OPUS` deliberately stays `claude-opus-4.8` — `claude-opus-5` / `claude-opus-5.5` are
 * plan-gated on Copilot (Pro+/Max/Business/Enterprise), so steering the curated Copilot presets
 * there would brick spawns on lower plans; both are catalog + pin-only on Copilot.
 *
 * No Haiku constant: `claude-haiku-4-5` faces an Anthropic retirement horizon (not before
 * 2026-10-15) with no Haiku 5 successor, so every cheap-flow claude row uses {@link SONNET}
 * pinned at `low` effort. Haiku stays in the catalog as a manually selectable model.
 *
 * `gpt-5.6-luna` is the cheap tier for BOTH codex and copilot rows. `gpt-5.4-mini` retires
 * 2026-08-31 and `gpt-5-mini` is the generation below it. Luna carries a live ladder rung
 * (luna → terra) for the presets that escalate.
 */

export const CLAUDE = 'claude-code';
export const COPILOT = 'github-copilot';
export const CODEX = 'openai-codex';
export const OPENCODE = 'opencode';

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5';
export const COPILOT_OPUS = 'claude-opus-4.8';
export const COPILOT_SONNET = 'claude-sonnet-5';
export const GPT_6_SOL = 'gpt-6-sol';
export const GPT_5_6_TERRA = 'gpt-5.6-terra';
export const GPT_5_6_LUNA = 'gpt-5.6-luna';

/**
 * OpenCode free-tier picks. The free tier rotates and individual ids go dark upstream (a 401
 * on one model while its siblings answer fine). Both picks were live-probed against
 * opencode-ai v1.18.32 on 2026-09-22; re-probe with `opencode models` before changing them.
 */
export const OPENCODE_BIG = 'opencode/big-pickle';
export const OPENCODE_MINI = 'opencode/nemotron-3.5-lightning-free';
