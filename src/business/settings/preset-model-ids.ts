/**
 * Model ids shared by the preset matrices and the per-provider defaults (`defaults.ts`). Hoisted
 * so each literal appears once and a catalog refresh cannot move the presets but strand the
 * defaults (or vice versa).
 *
 * The dash vs dot spelling is provider-specific and load-bearing: claude-code uses the dash
 * form (`claude-opus-5-5`, `claude-sonnet-5-5`) while github-copilot uses the dotted form
 * (`claude-…-4.8`). Do not normalise one into the other.
 *
 * Sonnet 5.5 is the Sonnet on both backends: `SONNET` (`claude-sonnet-5-5`, Claude Code >= 2.1.284)
 * and `COPILOT_SONNET` (`claude-sonnet-5.5`, Copilot Pro and up since the 2026-09-28 changelog — it
 * matches Sonnet 5 on coding in fewer steps and tokens at the same token price). Sonnet 5 stays in
 * both catalogs for pinned rows.

 * `COPILOT_OPUS` deliberately stays `claude-opus-4.8` — `claude-opus-5` / `claude-opus-5.5` are
 * plan-gated on Copilot (Pro+/Max/Business/Enterprise), so steering the curated Copilot presets
 * there would brick spawns on lower plans; both are catalog + pin-only on Copilot.
 *
 * `FABLE` (`claude-fable-5-1`) is Claude's flagship above Opus and appears ONLY on the frontier
 * presets' deep flows — 2.5x the Opus 5.5 price and it needs 30-day data retention (a
 * zero-data-retention org gets a 400). It is never a default or an escalation-ladder rung.
 *
 * No Haiku constant: `claude-haiku-4-5` faces an Anthropic retirement horizon (not before
 * 2026-10-15) with no Haiku 5 successor, so every cheap-flow claude row uses {@link SONNET}
 * pinned at `low` effort. Haiku stays in the catalog as a manually selectable model.
 *
 * Codex rows run the GPT-6 family: `gpt-6-luna` (cheap, $0.10/$0.50), `gpt-6.1-sol` (flagship,
 * top of the Codex ladder, the `gpt-6-sol` price), `gpt-6-astra` (premium, 5x sol — frontier presets
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
export const FABLE = 'claude-fable-5-1';
export const COPILOT_OPUS = 'claude-opus-4.8';
export const COPILOT_SONNET = 'claude-sonnet-5.5';
export const COPILOT_LUNA = 'gpt-6-luna';
export const GPT_6_ASTRA = 'gpt-6-astra';
export const GPT_6_1_SOL = 'gpt-6.1-sol';
export const GPT_6_LUNA = 'gpt-6-luna';

/**
 * Grok tiers: cheap `grok-4.5`, mid `grok-4.6`, flagship `grok-4.7`. Probed with `grok models` on
 * grok 1.0.40 (2026-09-22). `grok-4.6` and `grok-4.7` publish the same token price, so stepping
 * off the flagship saves effort tokens, not a lower rate. `grok-4.7-build-fast` is the same model
 * at twice the price and is not a preset pick.
 */
export const GROK_FLAGSHIP = 'grok-4.7';
export const GROK_MID = 'grok-4.6';
export const GROK_CHEAP = 'grok-4.5';

/**
 * OpenCode free-tier picks. The free tier rotates and individual ids go dark upstream (a 401
 * on one model while its siblings answer fine). Both picks were live-probed against
 * opencode-ai v1.18.32 on 2026-09-22; re-probe with `opencode models` before changing them.
 */
export const OPENCODE_BIG = 'opencode/big-pickle';
export const OPENCODE_MINI = 'opencode/nemotron-3.5-lightning-free';
