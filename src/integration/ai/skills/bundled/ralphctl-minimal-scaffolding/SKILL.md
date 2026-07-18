---
name: ralphctl-minimal-scaffolding
description: Cross-phase skill — question every piece of AI-workflow scaffolding on every model upgrade; remove non-load-bearing pieces one at a time with measurement. Complexity drifts upward by default; subtraction requires discipline. Governs scaffolding built around AI usage (prompts, wrapper scripts, guardrails, validation steps), not the task's application code — for code-level minimalism defer to the ralphctl-ponytail, ralphctl-surgical-simplicity, and ralphctl-karpathy-guidelines skills when installed in this session.
---

# Minimal Scaffolding

> "Find the simplest solution possible, and only increase complexity when needed. Every component encodes
> assumptions about model limitations. Stress-test assumptions; they can go stale quickly as models improve.
> Remove one component at a time when simplifying. Re-examine the whole system when a new model releases;
> strip non-load-bearing pieces."
>
> — Anthropic, [_Harness Design for Long-Running Application Development_](https://www.anthropic.com/engineering/harness-design-long-running-apps)

Scaffolding built around AI usage — prompts, wrapper scripts, extra validation steps, guardrails — drifts
upward in complexity by default. Each piece that solves a real problem at the time of its addition becomes a
permanent fixture, even after the model capability that made it necessary has improved past the threshold.
Without an active counter-pressure, the scaffolding grows into a weight that slows iteration and obscures the
actual design signal. Minimal scaffolding is not a one-time decision at design time; it is a discipline
applied on every model upgrade and on every proposed addition.

## When this applies

- **Refine** — before proposing that the requirements need an extra review gate, an extra validation pass,
  or an approval step to compensate for the model, ask whether the model would produce the right output
  without it given a well-scoped prompt.
- **Plan** — before adding an extra AI-assisted review step or splitting the work into more stages, ask
  whether the additional structure would improve output quality measurably, or whether it is defensive
  scaffolding against a past model's limitations.
- **Execute** — before wiring a new wrapper, guard clause, or retry layer around an existing AI-assisted
  check, ask which assumption about current model capability the addition encodes, and whether that
  assumption is still valid.

## What to do

1. **Start with the simplest viable shape.** Draft the simplest version that could work given today's model
   capability. Only add components when the simple version demonstrably fails.
2. **Question every component on every model upgrade.** When a new model version ships, re-read the
   project's own notes on why each piece of AI-workflow scaffolding exists, if the project keeps them. For
   each one, ask: "Would removing this component degrade output quality on the new model?" If the answer is
   uncertain, run the test.
3. **Remove one component at a time, measure.** Never remove two pieces of scaffolding simultaneously — you
   cannot isolate the regression. Remove one; run the project's check gate; observe output quality; decide.
4. **Default toward subtraction over addition.** When in doubt, omit. Adding a component later when its
   need is proven is cheaper than carrying a component whose need was assumed.

## Anti-patterns

- **Stacking guardrails "just in case".** Adding a validation wrapper around a check, a retry loop around
  the wrapper, and a review gate around the retry loop — each layer may have been justified at the time, but
  the stack encodes several separate assumptions, each of which needs re-validation on every model upgrade.
- **Treating scaffolding as load-bearing without measurement.** "We've always had this check" is not a
  reason to keep it — it is a reason to measure whether it still fires in practice. If it never fires on the
  current model, it may be removable.
- **Mass refactors that change more than one piece of scaffolding at a time.** Removing two guardrails in
  the same change makes it impossible to attribute a quality change to either. One piece at a time.
- **Never re-auditing existing scaffolding when models get better.** Capability improvements accrue quietly.
  A component that was essential for an older model may be transparently handled by a newer one. Without an
  explicit re-audit cadence, AI-workflow scaffolding ossifies around old assumptions.
