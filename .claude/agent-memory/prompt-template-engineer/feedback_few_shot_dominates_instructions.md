---
name: few-shot-dominates-instructions
description: Few-shot examples must be re-audited whenever a rule they illustrate changes — a stale example line silently overrides the surrounding prose instruction
metadata:
  type: feedback
---

**Durable principle: few-shot examples dominate instructions, so a stale example is a live bug, not a
cosmetic one.** `evaluate/template.md`'s Phase 1 rule said "run each `auto` criterion's command directly;
the verify script is the fallback ONLY when no `auto` criteria exist" — but all three few-shot examples
(each with `auto` criteria defined) opened their Phase 1 line with "verify script exits 0". A production
audit found evaluators were re-running the repo-wide verify gate every round regardless of the prose rule,
because the example anchored the model's behaviour more strongly than the surrounding instruction text.

**Why this matters:** the harness deliberately eliminated the redundant verify-script re-run (Phase 1's
own prose: "do NOT run the verify script … the harness runs it independently as the commit gate") to cut a
measured 4x-verify cost. A single inconsistent example line undid that optimisation in practice.

**How to apply:** whenever you edit a rule that few-shot examples illustrate, re-read every example's
opening line for that phase/step and fix each one to match the new rule — do not assume prose changes
propagate. Also check any prose "Note:" or aside inside the example body that references the old
mechanism (e.g. "the verify script passed") — those need the same fix for internal consistency. This
generalises beyond `evaluate/template.md`: any template with `<examples>` blocks (currently `evaluate`,
and now `evaluate-continuation` — see [[project_quality_sweep_2026_07_02]]) needs this check on every
edit to the surrounding protocol prose.
