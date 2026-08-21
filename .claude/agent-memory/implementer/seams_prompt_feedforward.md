---
name: seams_prompt_feedforward
description: The three feed-forward injections into implement/evaluate prompts — criteria history, dimension trajectory, prior learnings — and where each is composed
metadata:
  type: project
---

Three composers feed durable state forward into a FRESH session, replacing what an in-conversation
thread used to carry implicitly. They differ in where they are composed and which prompt they ride.

| Composer                     | Home                                                          | Placeholder                                  | Rides                         |
| ---------------------------- | ------------------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| `composeCriteriaHistory`     | `business/task/compose-criteria-history.ts`                   | `{{PRIOR_CRITERIA_VERDICTS}}`                | full implement + evaluate     |
| `composeDimensionTrajectory` | `business/task/dimension-trajectory.ts`                       | none — rides inside `PRIOR_CRITIQUE_SECTION` | full implement + continuation |
| `composePriorLearnings`      | `application/flows/_shared/memory/compose-prior-learnings.ts` | `{{PRIOR_LEARNINGS}}`                        | full implement only           |

## Criteria history — composed INSIDE the builders, not threaded

Renders `Task.criteriaVerdicts` (the durable per-criterion passed/failed/unknown map) as a compact
neutral block: "## Prior criteria verdicts" + "K of N done-criteria passing" + `- C1: passing` bullets.
Returns `''` when the map is absent/empty or every criterion is still `unknown`, so the placeholder
collapses.

**The design choice worth preserving:** the block is derived inside `buildImplementPrompt` /
`buildEvaluatePrompt` directly from `input.task` — NOT pre-composed in a leaf and threaded as a string.
`criteriaVerdicts` is a task field like `verificationCriteria`, and both builders already receive the
full `Task`, so no leaf input-projection change was needed. This is an integration→business import
(allowed; prompt-sibling isolation only fences prompt↔prompt).

`criteriaVerdicts` stores only the LATEST verdict per criterion (folded at settle by
`applyCriteriaVerdicts`), not a per-round count — so k/N is (passed)/(total). The block is deliberately
**neutral, with no directive**, because one renderer feeds both roles; each template adds its own
framing. The evaluate template wraps it with explicit "re-verify every criterion yourself; never carry a
prior PASS forward" prose so it can never become a rubber-stamp lever.

## Dimension trajectory — no new placeholder

Diffs `ctx.plateauHistory` (last vs prior turn) into fixed / still-failing(N) / newly-failing lines plus
a budget-pressure line at `plateauThreshold - 1`. It rides INSIDE `PRIOR_CRITIQUE_SECTION` —
`renderPriorCritiqueSection` took an optional second `trajectory` argument rather than minting a
placeholder. Threaded on both the full and continuation implement prompts. The generator leaf needs
`deps.plateauThreshold`, already present in `sharedLeafDeps` from gen-eval-loop.

## Prior learnings — loaded once, full prompt only

Caps to the 15 most-recent unpromoted ledger records, Insight + appliesTo only. Loaded ONCE in the
implement prologue via `loadLearningsLeaf` → `ctx.priorLearnings` (a run-scoped field, so it needs the
three-site treatment described in [[seams_attempt_ctx_and_telemetry]]). Rides the full prompt only — a
resumed thread already has it. The distill flow and its human gate are untouched.

Adding the `load-learnings` leaf to the prologue also required updating the flow-shape fence test's
`reconstructPreRefactorSerialFlow` — that reconstruction is independent, not factory-derived.

## Adding another optional prompt param

Placeholder in `template.md` + param spec in `definition.ts` with `optional: true` + a mapping line in
the builder. The per-flow `definition.test.ts` parity loops are generic (they diff placeholders vs
declared params in both directions), so a matched pair auto-passes — **add a focused render/collapse
test anyway.** `optional: true` is mandatory, not stylistic: the evaluate `validate-rejected` direct
`buildPrompt` tests omit new params and would otherwise fail on the wrong field.

Related: [[seams_escalation_ladder]], [[seams_memory_ledger_and_mutex]].
