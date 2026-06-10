---
name: project_gen_eval_speed_t1_t3
description: T1–T3 of feat/gen-eval-speed — new placeholders, renderers, and phrasing rules from the speed audit
metadata:
  type: project
---

Phase 1 of feat/gen-eval-speed (T1–T3) landed 2026-06-10. Summary for future sessions:

## New placeholders and renderers (all in \_engine/renderers/task.ts)

- `{{GENERATOR_HINTS_SECTION}}` — evaluate + evaluate-continuation. Renders a `<generator_hints>` XML-like block framing same-round generator observations as **unverified claims, never evidence**. Renderer: `renderGeneratorHintsSection(hints?)`. Input field: `generatorHints?` on `BuildEvaluatePromptInput` / `BuildEvaluateContinuationPromptInput`.
- `{{PRE_VERIFY_RESULTS}}` — implement + implement-continuation (inside `<pre_verify_results>…</pre_verify_results>`). Carries verbatim harness pre-task verify output; empty = collapses. Renderer: `renderPreVerifyResultsSection(preVerifyOutput?)`.
- `{{RETRY_FEEDBACK_SECTION}}` — implement + implement-continuation (inside `<retry_feedback>…</retry_feedback>`). Carries failing post-verify command + output tail from a regressed prior attempt. Renderer: `renderRetryFeedbackSection(retryFeedback?)`.

## Key phrasing locked in by this work

**Evaluator (Phase 1 step 1):** run each `auto` criterion's command directly; do NOT run `<verify_script>` — the harness runs it independently. Exception named inline: when the task has no `auto` criteria, use the verify script as fallback.

**Generator (Phase 3 step 2):** run each `auto` criterion's command once; do NOT run `<verify_script>`. Same exception.

**Generator (Phase 2.4):** run the cheapest check relevant to the touched module, not the full suite.

**Plan anti-pattern added:** steps must never end with "run all the checks" — verification belongs in `verificationCriteria`. Exception named inline.

**extraDimensions rule tightened:** attach ONLY when an acceptance criterion explicitly demands a measurable property no floor dimension covers AND no manual criterion already encodes it. When in doubt, omit.

## Wire-up still pending (T4, T5, T6)

- T4: wire `PRE_VERIFY_RESULTS` in `flows/implement/leaves/generator.ts`
- T5: wire `GENERATOR_HINTS` in `flows/implement/leaves/evaluator.ts`
- T6: red-post-verify bounded retry (wires `RETRY_FEEDBACK_SECTION`)

**Why:** The placeholders are prompt-only until the leaf wiring lands; they collapse to empty until T4–T6.

**How to apply:** When T4–T6 are implemented, check that `renderPreVerifyResultsSection`, `renderRetryFeedbackSection`, and `renderGeneratorHintsSection` are called with the correct domain values before calling the builder.
