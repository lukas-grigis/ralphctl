/**
 * Static lookup for a model's total token-context budget. Used by the provider adapters when
 * they emit a {@link TokenUsageEvent} — the TUI's budget widget needs both `inputTokens +
 * outputTokens` AND the denominator to render `(used / window)`. Without a per-model budget
 * the widget cannot draw a fill bar; just rendering the absolute token count is the fallback.
 *
 * Scope discipline: only entries we are confidently sure about. A guess here surfaces as a
 * wrong percentage in the TUI; an omission surfaces as "no fill bar, just raw counts."
 * Prefer the latter — add a model when the vendor publishes the value, not before.
 *
 *  - **Claude (Anthropic)** — the public model cards on https://www.anthropic.com/news
 *    list 200 000 tokens for the 4.x line (Haiku 4.5 / Sonnet 4.6 / Opus 4.8). The `[1m]`
 *    variants are 1 000 000 by definition — the suffix IS Claude Code's selector for the
 *    1M-token window, so the figure comes from the id itself, not a model card. The BASE
 *    fable-5 id has no published window figure yet — omitted, so the TUI renders raw counts
 *    until Anthropic documents it.
 *  - **Copilot** — model windows vary by upstream; the Copilot CLI does not surface the
 *    figure and we treat it as opaque until GitHub documents per-model windows. Omitted.
 *  - **Codex (OpenAI)** — `codex` proxies frontier models whose context windows the CLI
 *    does not surface; omitted until OpenAI publishes a stable per-model figure.
 *
 * Cross-vendor model-name collisions (e.g. Copilot routes a `claude-sonnet-4.6` upstream)
 * intentionally do NOT inherit Claude's window — each row is keyed on the literal identifier
 * the provider reports, since the model-side wrapping (system prompts, tool definitions, …)
 * differs per route.
 */
const CONTEXT_WINDOW: Readonly<Record<string, number>> = {
  // Claude (claude-code adapter — direct from Anthropic)
  'claude-haiku-4-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-opus-4-8': 200_000,
  // `[1m]` is Claude Code's 1M-token long-context selector — the window is part of the id.
  'claude-opus-4-8[1m]': 1_000_000,
  'claude-fable-5[1m]': 1_000_000,
};

/**
 * Look up the canonical context window for a provider-reported model id. Returns `undefined`
 * for unknown / unset models — emit the {@link TokenUsageEvent} without `contextWindow`, the
 * subscriber renders the raw counts.
 */
export const contextWindowFor = (model: string | undefined): number | undefined => {
  if (model === undefined) return undefined;
  return CONTEXT_WINDOW[model];
};
