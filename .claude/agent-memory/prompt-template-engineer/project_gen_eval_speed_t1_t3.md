---
name: project_gen_eval_speed_t1_t3
description: Gen-eval speed placeholders (pre-verify results, retry feedback, generator hints) and the phrasing rules locked in with them
metadata:
  type: project
---

Placeholders added by the gen-eval speed audit (2026-06-10), all rendered from
`_engine/renderers/task.ts` and wired into the leaves:

| Placeholder                   | Templates                         | Renderer                        | Carries                                                                            |
| ----------------------------- | --------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `{{GENERATOR_HINTS_SECTION}}` | evaluate, evaluate-continuation   | `renderGeneratorHintsSection`   | same-round generator observations, framed as **unverified claims, never evidence** |
| `{{PRE_VERIFY_RESULTS}}`      | implement, implement-continuation | `renderPreVerifyResultsSection` | verbatim harness pre-task verify output                                            |
| `{{RETRY_FEEDBACK_SECTION}}`  | implement, implement-continuation | `renderRetryFeedbackSection`    | failing post-verify command + output tail from a regressed prior attempt           |

All three collapse to empty string when their input is absent.

**Why:** these carry harness-side evidence into the prompt so the model does not re-derive it — the
whole point was cutting redundant verify runs.

**How to apply — phrasing rules locked in by this work, keep them intact when editing the templates:**

- **Evaluator Phase 1 step 1 / Generator Phase 3 step 2:** run each `auto` criterion's command directly;
  do NOT run `<verify_script>` — the harness runs it independently. Exception named inline: when the task
  has no `auto` criteria, the verify script is the fallback.
- **Generator Phase 2.4:** run the cheapest check relevant to the touched module, not the full suite.
- **Plan anti-pattern:** steps must never end with "run all the checks" — verification belongs in
  `verificationCriteria`. Exception named inline.
- **extraDimensions:** attach ONLY when an acceptance criterion explicitly demands a measurable property
  no floor dimension covers AND no manual criterion already encodes it. When in doubt, omit.
