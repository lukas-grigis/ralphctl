/**
 * UI-facing context-window helper — maps a provider-reported model id to its total token-context
 * budget and a compact display label.
 *
 * Lives in `domain/` (not `integration/`) for two reasons:
 *  1. The `Settings` entity and its model identifiers are domain-owned; the table belongs next to
 *     the other per-provider catalogs (`claude.ts`, `copilot.ts`, …).
 *  2. The TUI (`application/`) cannot import the integration-layer adapter
 *     (`providers/_engine/context-window.ts`) without violating the four-module layer rule.
 *
 * This intentionally duplicates the map that also lives in
 * `src/integration/ai/providers/_engine/context-window.ts`. Once ticket #226 lands and the
 * provider-engine is refactored, the integration copy should delegate here rather than maintaining
 * its own table. Until then keep both in sync when adding a new model entry.
 *
 * Scope discipline: only entries we are confident about. A guess here surfaces as a wrong label or
 * a wrong % bar in the TUI; an omission surfaces as "no label rendered". Prefer the latter — add a
 * model only when the vendor publishes the figure.
 *
 *  - **Claude (Anthropic)** — 200 000 for the 4.x line (Haiku 4.5 / Sonnet 4.6 / Opus 4.8).
 *    The `[1m]` suffix IS Claude Code's 1M-token long-context selector — the figure comes from
 *    the id itself, not a model card.
 *  - **Copilot / Codex** — omitted; the CLIs do not surface per-model window sizes.
 *
 * Pure domain — no `node:*` I/O.
 */

const CONTEXT_WINDOW: Readonly<Record<string, number>> = {
  // Claude (claude-code adapter — Anthropic direct)
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-8': 200_000,
  // `[1m]` is Claude Code's 1M-token long-context selector — the window IS the id suffix.
  'claude-opus-4-8[1m]': 1_000_000,
  'claude-fable-5[1m]': 1_000_000,
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
