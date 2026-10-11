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
 *  - **Claude (Anthropic)** — figures and sources live beside the table in
 *    `domain/value/settings-models/context-window.ts`.
 *  - **Copilot** — model windows vary by upstream; the Copilot CLI does not surface the
 *    figure and we treat it as opaque until GitHub documents per-model windows. Omitted.
 *  - **Codex (OpenAI)** — deliberately not tracked, even where OpenAI publishes a figure (the
 *    GPT-6 family is 1.05M total); the CLI does not surface per-model windows.
 *
 * Cross-vendor model-name collisions (e.g. Copilot routes a `claude-opus-4.8` upstream)
 * intentionally do NOT inherit Claude's window — each row is keyed on the literal identifier
 * the provider reports, since the model-side wrapping (system prompts, tool definitions, …)
 * differs per route.
 */
export { contextWindowFor } from '@src/domain/value/settings-models/context-window.ts';
