# Memory Index

- [feedback_inline_task_content.md](feedback_inline_task_content.md) — Inline task content in execute prompt — no
  context-file indirection; mirror buildEvaluatePrompt pattern
- [feedback_smoke_test_probes.md](feedback_smoke_test_probes.md) — Smoke tests must probe real placeholder content, not
  just "no unresolved tokens"
- [project_gen_eval_speed_t1_t3.md](project_gen_eval_speed_t1_t3.md) — New placeholders + renderers from speed-audit T1–T3; wire-up pending in T4–T6
- [project_provider_agnostic_reasoning.md](project_provider_agnostic_reasoning.md) — Replaced all `<thinking>`-block elicitations across 10 templates with neutral process directives; corrected false "harness strips thinking blocks" claims
- [feedback_few_shot_dominates_instructions.md](feedback_few_shot_dominates_instructions.md) — Few-shot examples override prose rules; re-audit every example whenever the rule it illustrates changes
- [feedback_dont_resubstitute_key_midsentence.md](feedback_dont_resubstitute_key_midsentence.md) — Never reference a section-style `{{KEY}}` a second time in prose — substitute.ts replaces every occurrence
- [project_quality_sweep_2026_07_02.md](project_quality_sweep_2026_07_02.md) — 2026-07-02 quality sweep: 9 verified defects fixed across 7 templates + 2 partials + HARNESS-PRINCIPLES.md; uncommitted
