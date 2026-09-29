---
name: lesson_prompt_contract_restated_invariants
description: When a prompt's output contract changes, grep the whole template for the old invariant restated in success_criteria / signal semantics / length guidance — they drift into contradictions
metadata:
  type: feedback
---

A prompt template states its output contract in several places (`<success_criteria>`, the rule
paragraph, the phase walkthrough, the signal-semantics list, length guidance). An edit that changes
the contract usually rewrites two or three of them and leaves one stale. Example caught: readiness
switched `content` to "additions only, empty when nothing to add" but `<success_criteria>` still
demanded "a non-empty `content` field", and the per-provider line cap still applied to `content`
(now only the delta, not the whole file).

**Why:** the parity/definition tests only check placeholders and a few `toContain` strings; nothing
fences internal consistency, so a contradiction ships green and the model resolves it unpredictably
(padding, retyping the body).

**How to apply:** for any template diff, list every noun the contract changed (field name, "whole
file", "non-empty", "verbatim", line caps) and grep the full template for each — not just the hunks.
Also grep the prompt's `definition.test.ts` comments for the old wording.

Related, for harness-side markdown splicers: probe setext headings (`Title\n---`) — ATX-only parsers
treat them as body text and swallow the following hand-authored section into the replaced region.
