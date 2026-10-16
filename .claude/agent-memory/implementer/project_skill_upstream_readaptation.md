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
- Upstream "Ask first / requires human approval" tiers: headless turns cannot ask. Map them to a
  generator-only `task-blocked` bullet (the passage must contain the word "generator", or the
  flow-signal test counts it against evaluator/judge) plus a `note` fallback carrying the literal
  phrase "when the prompt's output-contract section lists" — paraphrasing it loses the test exemption.
- Never port upstream artifact files or turn-ending approval gates (SPEC.md, tasks/plan.md, "STOP YOUR
  TURN"): refine/ideate own the single output signal and the operator approval gate, and ideate runs
  Phase 1 → Phase 2 in ONE session, so a stop-after-spec rule would break it.
- Prettier pads a markdown table to its widest cell, so one long new row in a bundled SKILL.md table
  rewrites every row of it. Fit new cells inside the existing column widths and move examples to a
  bullet, or the harvest diff buries the one real change.
- The flow-signal / evaluator mention scans demote any mention whose own sentence contains "not" or
  "never" ("say what was not verified in a `note` signal"), so that passage is never checked at all.
  Use the literal gate phrase anyway; the scan will not catch an ungated variant in such a sentence.
