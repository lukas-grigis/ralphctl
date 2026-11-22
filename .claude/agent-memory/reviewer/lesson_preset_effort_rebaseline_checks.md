---
name: preset-effort-rebaseline-checks
description: Preset effort/model re-alignment diffs — lowering a top effort reactivates the effort rung (and Copilot's never fires); doc claims drift from the verdicts; how to settle Claude price/retention facts
metadata:
  type: feedback
---

When a diff lowers preset efforts (e.g. `max` → `high`) or collapses model tiers, the matrix value pins in
`presets.test.ts` go green by construction; the drift is in prose and in escalation behaviour.

**Why:** lowering a frontier row from `max` to `high` re-enabled the Claude effort rung (`max` was "spent"),
so docblocks saying "a frontier generator never escalates" became false while every test passed. The same
change on Copilot did the opposite: `FIXED_EFFORT_RUNG['github-copilot']` targets `high` and counts
`high`/`xhigh`/`max` as spent, so a Copilot Opus row lowered to `high` has no climb at all. Collapsing Grok
to one model made the economic/strong-gate ladder invariants pass vacuously (path of length 1).

**How to apply:**

- Probe with a scratchpad tsx script (`npx tsx --tsconfig tsconfig.json <file>` from the repo root): for every
  `PRESET_NAMES` entry print the generator's model rung (`mergeEscalationMap`) and `nextEffortRung`, and
  flag pairs of presets with identical rows. Compare against each docblock's escalation claim.
- Grep docs for "vendor start point" / "vendor guidance" phrasing and check each against the
  RESEARCH-REFERENCES row verdict: a row marked "corrected ... our judgment" cited elsewhere as the vendor's
  start point is a grounding violation.
- A blanket sentence ("evaluator rows stay at X", "rows not listed are unchanged") — test it against every
  family, including frontier, where the rows moved most.
- Claude model price and data-retention facts (e.g. Fable 5.2 $8/$40, ZDR orgs get a 400): invoke the
  `claude-api` skill; its model table settles "2.5x Opus" style docblock claims without a web fetch.

Related: [[model-bump-drift-grep-list]], [[lesson_binding_decision_over_design_table]].
