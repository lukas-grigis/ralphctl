/**
 * Model ids shared by the preset matrices and the per-provider defaults (`defaults.ts`). Hoisted
 * so each literal appears once and a catalog refresh cannot move the presets but strand the
 * defaults (or vice versa).
 *
 * The dash vs dot spelling is provider-specific and load-bearing: claude-code uses the dash
 * form (`claude-opus-5-5`, `claude-sonnet-5-5`) while github-copilot uses the dotted form
 * (`claude-opus-5.5`). Do not normalise one into the other.
 *
 * Sonnet 5.5 is the Sonnet on both backends: `SONNET` (`claude-sonnet-5-5`, Claude Code >= 2.1.284)
 * and `COPILOT_SONNET` (`claude-sonnet-5.5`, Copilot Pro and up since the 2026-09-28 changelog — it
 * matches Sonnet 5 on coding in fewer steps and tokens at the same token price). Sonnet 5 stays in
 * both catalogs for pinned rows.
 *
 * `COPILOT_OPUS` is `claude-opus-5.5`, which GitHub gates to Pro+ and up; an unavailable Opus 5.5
 * steps to Sonnet 5.5.
 *
 * `HAIKU` (`claude-haiku-5-5`) runs only the fast / economic Claude presets' light flows; implement
 * stays on Sonnet or above.
 *
 * `FABLE` (`claude-fable-5-2`) is Claude's flagship above Opus and appears ONLY on the frontier
 * presets' deep flows — every Fable model needs 30-day data retention (a zero-data-retention org
 * gets a 400). It is never a default or an escalation-ladder rung.
 *
 * Codex rows run the GPT-6 family: `gpt-6-luna` (cheap, $0.10/$0.50), `gpt-6.2-sol` (flagship,
 * the CLI default, top of the Codex ladder), `gpt-6.2-astra` (premium — frontier presets
 * only, never a ladder rung). Copilot light rows run `gpt-6-luna` too (Pro and up; half the
 * `gpt-5.6-luna` input price on Copilot and reachable on the reference account, 2026-10-03).
 */

export const CLAUDE = 'claude-code';
export const COPILOT = 'github-copilot';
export const CODEX = 'openai-codex';
export const OPENCODE = 'opencode';
export const GROK = 'xai-grok';

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-5-5';
export const FABLE = 'claude-fable-5-2';
export const COPILOT_OPUS = 'claude-opus-5.5';
export const COPILOT_SONNET = 'claude-sonnet-5.5';
export const COPILOT_LUNA = 'gpt-6-luna';
export const GPT_6_2_ASTRA = 'gpt-6.2-astra';
export const GPT_6_2_SOL = 'gpt-6.2-sol';
export const GPT_6_LUNA = 'gpt-6-luna';

/**
 * Grok presets and defaults run `grok-4.7` only: 4.5 / 4.6 / 4.7 bill the same rate, so cost is
 * bought through effort. `GROK_MID` / `GROK_CHEAP` remain as availability-fallback steps in
 * `adapt-to-available-models.ts`. `grok-4.7-build-fast` is the same model at twice the price and
 * is not a preset pick.
 */
export const GROK_FLAGSHIP = 'grok-4.7';
export const GROK_MID = 'grok-4.6';
export const GROK_CHEAP = 'grok-4.5';

/**
 * OpenCode free-tier picks. The free tier rotates and individual ids go dark upstream (a 401
 * on one model while its siblings answer fine). Both picks were live-probed against
 * opencode-ai v1.18.35 on 2026-11-22; re-probe before changing them. MINI is zero-retention: refine,
 * readiness and create-pr send repo content, so never pick a "trial use only" (NVIDIA) endpoint.
 */
export const OPENCODE_BIG = 'opencode/big-pickle';
export const OPENCODE_MINI = 'opencode/deepseek-v4.1-flash-free';
