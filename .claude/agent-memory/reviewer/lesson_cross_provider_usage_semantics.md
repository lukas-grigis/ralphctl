---
name: lesson_cross_provider_usage_semantics
description: Token-usage diffs — a column label like "uncached in" is a claim about all five providers; legacy defaults of 0 render as fact; probe with the real pre-change results file
metadata:
  type: feedback
---

When a diff relabels or re-sums provider token counts (ProviderUsage, eval budget, summary.md, TUI cards),
the label is a claim about every adapter, not just the one the author checked.

**Why:** Claude reports `cache_read_input_tokens` beside `input_tokens`; Codex's recorded
`turn.completed` fixture has `cached_input_tokens` 25344 _inside_ `input_tokens` 27669. A diff that
labelled every provider's `inputTokens` "uncached in" was wrong for Codex by its own fixture, and it
populated Grok's cache fields (Anthropic-style names, relation to input unverified) while excluding
Codex/OpenCode for exactly that reason. The asymmetry was in the grounding, not the tests.

**How to apply:**

- For each of claude/codex/copilot/opencode/grok, open the adapter's usage parser and its recorded
  fixture in `tests/integration/ai/providers/<tool>/`; check whether input includes or excludes cache.
- A legacy-tolerance default of `0` for a field that was never recorded prints as a real zero. Run the
  offline report on a real pre-change results file (`pnpm eval report <f> <f>`, 0 tokens) and read what
  the old run now claims.
- `toContain('cache read 5000')` on a rendered summary can match the budget line instead of the per-flow
  usage line; give the two sources different numbers.

Related: [[lesson_second_implementation_of_shared_rule]], [[lesson_ab_harness_review_checks]].
