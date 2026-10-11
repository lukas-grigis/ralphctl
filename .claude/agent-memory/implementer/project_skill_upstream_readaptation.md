---
name: skill-upstream-readaptation
description: Re-applying upstream skill drift into bundled SKILL.md — diff noise, the read-only evaluator trap, and which upstream features never port
metadata:
  type: project
---

- Older `scripts/vendor/skills/` snapshots were prettier-formatted before `scripts/vendor/` joined
  `.prettierignore`, so a raw refresh shows table/blank-line churn. Read drift with
  `git diff -w --ignore-blank-lines` or you will "port" formatting.
- The evaluator session is read-only except `signals.json` (evaluate prompt). Any upstream advice that
  edits the tree (e.g. code-review's invert-a-condition mutation probe) must be scoped to the generator,
  with a reason-it-through fallback for the evaluator.
- Never port: slash-command levels / persistence (ponytail `/ponytail lite|full|ultra`), "run the full
  suite before done" (S6 — harness owns the gate), cross-references to upstream skills that are not
  bundled, upstream severity-label renames (bundled code-review deliberately uses its own
  Critical/Major/Minor/Nit scale — map new upstream severity guidance onto it rather than importing labels).
- No static content hash exists for bundled skills; `.provenance.json` hashes are computed at runtime,
  so editing a bundled SKILL.md surfaces as `update-available` to operators who enabled a copy — expected.
