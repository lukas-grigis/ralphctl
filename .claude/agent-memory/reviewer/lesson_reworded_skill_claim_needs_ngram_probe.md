---
name: lesson_reworded_skill_claim_needs_ngram_probe
description: A bundled skill claiming "written fresh / reworded, not copied" from a license-sensitive upstream should be checked with a 5-gram overlap probe against the vendored raw copy
metadata:
  type: feedback
---

When a skill's attribution blockquote or the sources manifest says its catalogue is "written fresh" or "paraphrased,
never copied" (e.g. a humanizer derived from a CC BY-SA page), probe it: tokenise the bundled SKILL.md and the
`scripts/vendor/skills/<name>/SKILL.md` raw copy, count shared 5-word shingles (`python3 -I`, scratchpad script).

**Why:** the claim is the only guard against re-publishing share-alike text, and an implementer can reword the lists
while leaving whole instruction sentences verbatim ("Keep a contrast only when …"). A green gate never looks.

**How to apply:** report hits as a nonblocking note unless they are the Wikipedia-derived lists themselves; ask the
parent to either reword the leftover sentences or soften the "written fresh" wording. Also note the raw vendor copy
is committed to the public repo even though `package.json` `files` keeps it out of the tarball.
