---
name: project_provider_agnostic_reasoning
description: Shared templates never elicit <thinking>/<reasoning> blocks — reasoning depth is a per-provider effort-adapter concern, not prompt text
metadata:
  type: project
---

Decision: no `<thinking>`-block or XML reasoning-tag elicitation in shared prompt templates. Verified
2026-08-19 — zero such tags remain under `src/integration/ai/prompts/`.

**Why:** one harness spans four provider backends — Claude (server-side extended thinking already on),
Codex (o-series hidden reasoning ignores the instruction), Copilot (model-dependent), OpenCode
(model-dependent per aggregated model). Eliciting tag-shaped visible reasoning is redundant on one, dead
on another, and unpredictable on the rest. Reasoning depth is controlled at the per-provider effort
adapter seam.

**How to apply:** never instruct the model to open a `<thinking>` block, write a `<reasoning>` block, or
emit `<evaluation_thinking>` / `<criterion_checkpoint>` tags. Use neutral process directives instead:
"Before starting X, work through Y" / "Before writing output, cover, in order:". Structural
section-delimiter XML tags (`<role>`, `<goal>`, `<inputs>`, `<constraints>`, `<evaluation_discipline>`,
…) are fine — every model reads them as delimiters and they cause no portability problem.

Related trap fixed in the same pass: templates claiming "the harness strips thinking blocks" were false.
The accurate statement is "only `signals.json` is read by the harness; all other session output is
forensic and not persisted as data." Do not reintroduce the stripping claim.
