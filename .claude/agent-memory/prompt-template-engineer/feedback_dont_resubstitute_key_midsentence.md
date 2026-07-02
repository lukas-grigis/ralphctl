---
name: dont-resubstitute-key-midsentence
description: Never reference a multi-paragraph {{KEY}} a second time inline in prose — substitute.ts replaces every occurrence, so the whole block re-renders where a short phrase was intended
metadata:
  type: feedback
---

**Durable principle: `{{KEY}}` is not a citation token — every occurrence gets the full replacement
body.** `evaluate/template.md` rendered `{{FLOOR_RUBRIC_SECTION}}` once near the top (correct, full
rubric) and then referenced it again mid-sentence in backticks ("...rendered in `{{FLOOR_RUBRIC_SECTION}}`
above") intending it as a short pointer back to the earlier block. Because `substitute.ts` replaces ALL
occurrences of a key with the same verbatim string, that second occurrence actually re-injected the
entire multi-paragraph rubric into the middle of a sentence.

**Why this matters:** this class of bug is easy to introduce because it reads correctly in the raw
template source (a plausible cross-reference) and only breaks once rendered — visual review of the
`.md` file alone won't catch it; you have to trace the substitution mentally or render it.

**How to apply:** when you want to reference a section the reader already saw, use plain prose
("the grading rubric pinned at the top of this prompt") — never re-embed the placeholder token itself
outside its single intended render site. Audit for this pattern whenever a template has a large
section-style placeholder (anything ending in `_SECTION`) — grep the template for the key name and
confirm it appears exactly once, unless multiple full renders are actually intended.
