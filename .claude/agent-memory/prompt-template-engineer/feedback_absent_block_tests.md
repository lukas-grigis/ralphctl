---
name: absent-block-tests
description: Asserting an empty block is absent by `not.toContain('<tag>')` is unreliable — template prose often names the tag in backticks
metadata:
  type: feedback
---

When a renderer owns the wrapper tag (empty body renders nothing), assert absence with `'<tag>\n'` (tag followed by newline) or the preface sentence, not bare `'<tag>'`.

**Why:** implement's template prose mentions `<retry_feedback>` / `<prior_criteria_verdicts>` in backticks, so a bare check fails even when the block is correctly absent.

**How to apply:** any test for a renderTaggedBlock-backed placeholder in a full-template render.
