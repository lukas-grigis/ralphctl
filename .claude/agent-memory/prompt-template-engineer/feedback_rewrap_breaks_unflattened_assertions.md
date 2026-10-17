---
name: feedback-rewrap-breaks-unflattened-assertions
description: Reflowing a template or partial paragraph can fail definition tests that assert a phrase on the raw rendered string — grep the tests for the sentence before rewrapping
metadata:
  type: feedback
---

Some definition tests assert a phrase against the raw rendered prompt without collapsing whitespace, so a line break inside that phrase fails them even though the prompt reads the same. Seen with `audit the claim against a tool result from this session` (implement test) and `/Prefer this over any inference from manifest/` (detect-scripts test).

**Why:** the tests were written against the line breaks the source happened to have; only newer tests flatten with `.replace(/\s+/g, ' ')`.

**How to apply:** before reflowing a paragraph, grep `tests/integration/ai/prompts` for a distinctive phrase from it. Keep a pinned phrase on one line, or split the paragraph so the sentence stays intact. Write new assertions on the flattened string.
