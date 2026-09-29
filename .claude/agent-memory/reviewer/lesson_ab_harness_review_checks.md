---
name: lesson_ab_harness_review_checks
description: Three checks for any A/B / eval tooling that claims "measures what ships" — per-flow parity, identical-input tests, and tsx-resolved "bundled" dirs
metadata:
  type: feedback
---

Three bug classes a green suite missed in an offline A/B eval harness (`scripts/eval/`):

1. **"Same as production" was true for one flow, assumed for all.** The design said every flow validates
   with `validateSignalsFileWithCorrectiveRetry`. Only implement's generator and evaluator do; detect-scripts
   (`propose.ts`) and the best-of-N judge (`best-of-n-judge.ts`) call plain `validateSignalsFile` and fall back
   on an invalid file. The harness nudged everywhere, so it scored outcomes production never produces.
   **How to apply:** for every adapter that claims parity, grep the production leaf's validate, session and
   prompt call and compare them line by line. Don't compare per flow family.

2. **A merge test that feeds the same file twice can't see overwrites.** `report` relabelled trials to
   baseline and candidate, but it merged the stored `metrics` and `usage` maps, which were keyed by the old
   arm name. Both runs used `baseline`, so the candidate's numbers replaced the baseline's under the baseline
   label. The only test copied one results file to two paths.
   **How to apply:** probe with two inputs that differ, e.g. edit one metric's mean and grep the rendered output.

3. **Under `tsx`, "bundled" means the working tree.** `defaultTemplatesDir()` resolves to
   `src/integration/ai/prompts`. A documented `compare --candidate-templates ./src/integration/ai/prompts`
   therefore reads the same directory in both arms, an A/A run that always reports "no detectable difference".
   Equal `templatesHash` values in the two arms give it away.
   **How to apply:** print what the baseline resolves to (`npx tsx -e "import(...)..."`) before trusting any
   doc example that compares against "the bundled" copy.

Related: [[lesson_partial_wiring_of_general_seam]], [[feedback_typecheck_probe]].
