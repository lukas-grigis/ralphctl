---
name: criteria-history-feedforward-seam
description: composeCriteriaHistory (business) feeds durable per-criterion k/N verdicts to BOTH generator+evaluator prompts — derived INSIDE the prompt builders from input.task, not threaded through leaves
metadata:
  type: project
---

`composeCriteriaHistory` (`src/business/task/compose-criteria-history.ts`) renders `Task.criteriaVerdicts`
(the durable per-criterion passed/failed/unknown map) into a compact neutral block ("## Prior criteria
verdicts" + "K of N done-criteria passing" + `- C1: passing` bullets). Returns '' when the map is
absent/empty or every criterion is still `unknown`, so the `{{PRIOR_CRITERIA_VERDICTS}}` placeholder
collapses. Feeds a FRESH attempt (post-escalation, new session) the k/N history the prior in-conversation
thread carried but a new session lost.

**Key design choice:** the block is derived INSIDE the two prompt builders (`buildImplementPrompt` /
`buildEvaluatePrompt`) directly from `input.task` — NOT pre-composed in a leaf and threaded as a string.
`criteriaVerdicts` is a task field (like `verificationCriteria`, which `renderVerificationCriteriaSection`
already renders from the task), and both builders already receive the full `Task`, so no generator.ts /
evaluator.ts input-projection change was needed. This is an integration→business import (allowed;
prompt-sibling isolation only fences prompt↔prompt). It rides the FULL implement prompt automatically
(fresh-session branch) — the continuation prompt does not carry it, which is fine (mid-session already has
it in-conversation).

**Why:** `criteriaVerdicts` stores only the LATEST verdict per criterion (folded at settle by
`applyCriteriaVerdicts`), NOT a per-round count — so the renderer's k/N is (passed count)/(total criteria),
and the block is neutral (no directive) because ONE renderer feeds both roles; each template adds its own
framing. The evaluate template wraps it with explicit "re-verify every criterion yourself; never carry a
prior PASS forward" prose so the block never becomes a rubber-stamp lever.

**How to apply:** a new optional prompt param needs the placeholder in template.md + the param spec in
definition.ts (`optional: true`) + a mapping line in the builder; the per-flow `definition.test.ts` parity
loops are generic (they diff template placeholders vs declared params both directions) so a matched
pair auto-passes — but add a focused render/collapse test anyway. The evaluate `validate-rejected` direct
`buildPrompt` tests omit the new param, so it MUST be `optional: true` (else they'd fail on the wrong
field). Sibling: [[project_effort_escalation_rung_seam]] (both landed 2026-07-02 in the same activation).
