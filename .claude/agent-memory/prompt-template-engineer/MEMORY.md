# Memory Index

- [feedback_inline_task_content.md](feedback_inline_task_content.md) — Inline task fields into the prompt body; never a per-task context-file indirection
- [feedback_smoke_test_probes.md](feedback_smoke_test_probes.md) — Placeholder parity is the syntax guard; assert real rendered content for the regression guard
- [feedback_few_shot_dominates_instructions.md](feedback_few_shot_dominates_instructions.md) — Few-shot examples override prose rules; re-audit every example whenever the rule it illustrates changes
- [feedback_dont_resubstitute_key_midsentence.md](feedback_dont_resubstitute_key_midsentence.md) — Never reference a section-style `{{KEY}}` a second time in prose — substitute.ts replaces every occurrence
- [project_gen_eval_speed_t1_t3.md](project_gen_eval_speed_t1_t3.md) — Pre-verify / retry-feedback / generator-hints placeholders and the verify-script phrasing rules they lock in
- [project_provider_agnostic_reasoning.md](project_provider_agnostic_reasoning.md) — No `<thinking>`/`<reasoning>` elicitation in shared templates; reasoning depth lives at the effort-adapter seam
