---
name: project_provider_agnostic_reasoning
description: Replaced all <thinking>-block elicitations and reasoning XML wrappers with neutral process directives across 10 templates; false "harness strips thinking blocks" claims corrected; evaluate tags replaced with <evaluation_discipline>
metadata:
  type: project
---

Decision: remove all `<thinking>`-block and XML reasoning-tag elicitations from shared prompt templates.

**Why:** ralphctl runs one harness across three providers — Claude (server-side extended thinking already on),
Codex (o-series hidden reasoning ignores the instruction), Copilot (model-dependent). Eliciting tag-shaped
visible reasoning is redundant on Claude, dead on Codex, and model-dependent on Copilot. Reasoning depth is
controlled at the per-provider effort adapter seam, not in shared prompt text.

**How to apply:** When authoring or reviewing templates, never instruct the model to open a `<thinking>` block,
write a `<reasoning>` block, or emit `<evaluation_thinking>` / `<criterion_checkpoint>` tags. Use neutral
process directives instead: "Before starting X, work through Y" / "Before writing output, cover, in order:".
Structural section-delimiter XML tags (`<role>`, `<goal>`, `<inputs>`, `<constraints>`, etc.) are fine — all
models read them as section delimiters and they cause no portability problem.

Per-template changes shipped:

- `implement/template.md` — removed `<reasoning>` wrapper; Phase 1 opener and prior-critique list item neutralised.
- `apply-feedback/template.md` — removed `<reasoning>` wrapper; Phase 1 opener neutralised.
- `detect-scripts/template.md` — Phase 1 opener neutralised; false "harness strips thinking blocks" → accurate "Only `signals.json` is read by the harness; all other session output is forensic and not persisted as data."
- `detect-skills/template.md` — `<inspection_protocol>` opener neutralised.
- `ideate/template.md` — Step 1.0 and Step 2.0 openers neutralised.
- `plan/template.md` — removed `<reasoning>` wrapper; neutral directive added before Step 1; false "harness strips thinking blocks" removed; Step 2 closer neutralised.
- `readiness/template.md` — Phase 1 opener neutralised.
- `refine/template.md` — Step 1 opener neutralised; false "harness discards `<thinking>` blocks" → accurate "Only `signals.json` is read by the harness."
- `evaluate/template.md` — replaced `<reasoning_protocol>` + `<checkpoint_protocol>` with `<evaluation_discipline>`; removed stray `<reasoning>` block; Phase 1 opener neutralised.
- `evaluate-continuation/template.md` — replaced `<checkpoint_protocol>` with `<evaluation_discipline>`.

No placeholders, substitution wiring, or `.ts` files were changed. All 195 prompt integration tests pass.
