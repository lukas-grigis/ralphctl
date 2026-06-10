---
name: project_gen_eval_speed
description: feat/gen-eval-speed branch: 7-workstream sprint to reduce harness overhead (prompt hygiene, red-post-verify retry, structured verify gates, gen→eval signal threading, picker effort fix, pre-verify setup skip, TUI harness settings)
metadata:
  type: project
---

feat/gen-eval-speed branch exists. Seven workstreams user-approved. Planning completed 2026-06-10.

**Why:** 23-min single-task sprint audit revealed 4x verify-script runs, redundant pre-verify, prompts inducing extra work, gen→eval signal isolation, picker silently inheriting xhigh effort on model-only override, evaluator-passed + red-post-verify blocking (no retry path).

**Key dependency chain:**

- WS1 (prompts) can start immediately; establishes PRE_VERIFY_RESULTS and RETRY_FEEDBACK_SECTION placeholders that WS2 consumes.
- WS2 (red-post-verify retry) depends on WS1 (needs the new placeholder rendered) and uses existing quarantine-retry-diff leaf.
- WS3 (structured verify gates) touches pre/post-task-verify leaves which WS6 also modifies — sequence WS6 after WS3 settles the leaf shape.
- WS4 (gen→eval threading) is narrow: ctx + evaluator leaf + evaluator prompt param + definition.ts only.
- WS5 (picker effort fix) and WS7 (TUI harness settings) are both blocked on WIP landing (flows-customize-picker.ts, settings-view.tsx, settings-view-model.ts).
- WS6 (pre-verify skip-on-setup) touches pre-task-verify leaf, which WS3 also changes — sequence WS6 after WS3.

**How to apply:** when planning future work on the verify leaves or prompt templates, check whether this branch's changes have landed.
