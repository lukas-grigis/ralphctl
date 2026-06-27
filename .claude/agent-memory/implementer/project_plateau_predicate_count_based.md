---
name: plateau-predicate-count-based
description: The gen-eval plateau predicate is FAILED-DIMENSION-COUNT based (not identical-set); driving a multi-turn loop test past it needs dissimilar critiques
metadata:
  type: project
---

`computePlateauVerdict` in `business/task/plateau-detection.ts` flags a stall when the failed-dimension
COUNT never DECREASES across the window AND the current turn still has failures — NOT when the failed SET is
identical (that was the legacy check). So rotating WHICH single dimension fails each turn does NOT keep the
evaluator's own plateau quiet: count stays constant (1,1,1) → stall → plateau exit at `threshold` turns.

**Two exemptions, checked in order (only consulted once a stall is detected):**

1. **critique-shift** — current critique's max trigram-Jaccard vs every prior in the window `< 0.5` → returns
   `{kind:'progress'}`, loop continues. This is the reliable lever to keep a loop running for a test.
2. **work-product-changed** — `changedFilesHash` differs from every prior in the window → `{kind:'warning'}`,
   capped at `WARNING_SOFTEN_CAP=2` consecutive softenings, then fires anyway.

**How to apply (test design — `gen-eval-loop.test.ts` R2 entropy tests):** to drive the gen-eval loop across
N turns WITHOUT any plateau exit firing so a LATER guard (entropy-check) can be exercised in isolation, the
scripted evaluator must satisfy BOTH:

- ROTATE the single failing floor dim each turn (correctness→completeness→safety→…) so the R1
  loop-diversity-check fingerprint stays diverse (it joins sorted failed-dim names), AND
- give a genuinely DISSIMILAR critique each turn (pairwise Jaccard < 0.5 — distinct full sentences, the e2e
  "exhausted budget" test's technique) so the count-based evaluator plateau is exempted via critique-shift.
  Empty/stub gitRunner ⇒ identical `changedFilesHash` every turn ⇒ work-product exemption never helps; rely on
  critique-shift. The R2 entropy guard then fires at turn == `DIVERSITY_WINDOW_SIZE` (3) when generator action
  entropy is collapsed (single signal kind) and budget remains (`turnsUsed < maxTurns`). See
  [[project_loop_diversity_budget_precedence]] for the budget-precedence guard that suppresses both diversity
  guards on the final turn. The entropy guard reads `ctx.lastTurnActionCounts` (signal-kind distribution proxy —
  the harness never sees raw tool-use), stamped by the generator leaf's output projection every turn.
