/** Maps a provider-reported model id to its total token-context budget and a compact display label. */

const CONTEXT_WINDOW: Readonly<Record<string, number>> = {
  // Claude (claude-code adapter — Anthropic direct)
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  // 1M on Opus 4.8 is plan-dependent in Claude Code; the `[1m]` id below carries it.
  'claude-opus-4-8': 200_000,
  // Haiku 5.5 — natively 1M in Claude Code, no `[1m]` selector.
  'claude-haiku-5-5': 1_000_000,
  // Sonnet 5.5 and Sonnet 5 always run at their native 1M window on the Anthropic API — no `[1m]`
  // selector, so the bare id carries the 1M figure directly.
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  // Opus 5 — natively 1M in Claude Code — no `[1m]` selector; the bare id carries the figure.
  'claude-opus-5': 1_000_000,
  // Opus 5.5 and Fable 5.1 — natively 1M (default AND max) in Claude Code, no `[1m]` selector.
  'claude-opus-5-5': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  // `[1m]` is Claude Code's 1M-token long-context selector — the window IS the id suffix.
  'claude-opus-4-8[1m]': 1_000_000,
  'claude-fable-5[1m]': 1_000_000,
  // Grok (xai-grok adapter — docs.x.ai published window; build-fast is the same model)
  'grok-4.7': 500_000,
  'grok-4.7-build-fast': 500_000,
  'grok-4.6': 500_000,
  'grok-4.5': 500_000,
};

/**
 * Look up the canonical context window for a provider-reported model id. Returns `undefined`
 * for unknown / unset models — callers render raw counts or omit the window label entirely.
 */
export const contextWindowFor = (model: string | undefined): number | undefined => {
  if (model === undefined) return undefined;
  return CONTEXT_WINDOW[model];
};

/**
 * The largest window in the table — the single figure any window-scaled budget derived from
 * this catalog (e.g. `progressCapBudgetForModel`'s sibling-section budget, or a backstop cap
 * sized to never fire below the largest legitimate window-scaled output) must stay pinned to.
 * Recomputed from the table itself so a new catalog entry with a bigger window is picked up
 * automatically rather than requiring a second hand-maintained constant.
 */
export const MAX_CONTEXT_WINDOW = Math.max(...Object.values(CONTEXT_WINDOW));

/**
 * Compact display label for a model's context window size:
 *   `200_000` → `"200K"`, `1_000_000` → `"1M"`, `1_200_000` → `"1.2M"`.
 * Returns `undefined` when the model is unknown or unset — callers should omit the label.
 */
export const contextWindowLabel = (model: string | undefined): string | undefined => {
  const w = contextWindowFor(model);
  if (w === undefined) return undefined;
  if (w >= 1_000_000) {
    const m = w / 1_000_000;
    return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  const k = w / 1_000;
  return `${k.toFixed(1).replace(/\.0$/, '')}K`;
};
