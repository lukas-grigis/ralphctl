---
name: ralphctl-minimal-scaffolding
description: Cross-phase skill — question every harness component on every model bump; remove non-load-bearing pieces one at a time with measurement. Complexity drifts upward by default; subtraction requires discipline.
---

# Minimal Scaffolding

> "Find the simplest solution possible, and only increase complexity when needed. Every component encodes
> assumptions about model limitations. Stress-test assumptions; they can go stale quickly as models improve.
> Remove one component at a time when simplifying. Re-examine entire harness when new model releases; strip
> non-load-bearing pieces."
>
> — Anthropic, [_Harness Design for Long-Running Application Development_](https://www.anthropic.com/engineering/harness-design-long-running-apps)

Harness complexity drifts upward. Each component that solves a real problem at the time of its addition
becomes a permanent fixture — even after the model capability that made it necessary has improved past the
threshold. Without an active counter-pressure, the harness grows into a weight that slows iteration and
obscures the actual design signal. Minimal scaffolding is not a one-time decision at design time; it is a
discipline applied on every model release and on every proposed addition.

## When this applies

- **Refine** — before proposing that the refine phase needs a new guard, new evaluator, or new validation
  step, ask whether the model would produce the right output without it given a well-scoped prompt.
- **Plan** — before adding a new planning sub-agent or splitting a flow into more phases, ask whether the
  additional structure would improve output quality measurably, or whether it is defensive scaffolding
  against a past model's limitations.
- **Execute** — before wiring a new chain primitive, a new leaf, or a new wrapper around the evaluator, ask
  which assumption about current model capability the addition encodes, and whether that assumption is still
  valid.

## What to do

1. **Start with the simplest viable shape.** Draft the simplest version that could work given today's model
   capability. Only add components when the simple version demonstrably fails.
2. **Question every component on every model bump.** When a new model version ships, re-read
   `HARNESS-PRINCIPLES.md` § 14 and § 18 in the project's `.claude/docs/` directory. For each `applied` row,
   ask: "Would removing this component degrade output quality on the new model?" If the answer is uncertain,
   run the test.
3. **Remove one component at a time, measure.** Never refactor two components simultaneously — you cannot
   isolate the regression. Remove one; run the project's check gate; observe output quality; decide.
4. **Default toward subtraction over addition.** When in doubt, omit. Adding a component later when its
   need is proven is cheaper than carrying a component whose need was assumed.

## Anti-patterns

- **Stacking primitives "just in case".** Adding a `guard` around the evaluator, a `loop` around the guard,
  and a retry decorator around the loop — each layer may have been justified at the time, but the stack
  encodes four separate assumptions, each of which needs re-validation on every model bump.
- **Treating scaffolding as load-bearing without measurement.** "We've always had the idle watchdog" is not
  a reason to keep it — it is a reason to measure whether it still fires in practice. If it never fires on
  the current model, it may be removable.
- **Mass refactors that change more than one component at a time.** Removing the plateau detector and the
  idle watchdog in the same PR makes it impossible to attribute a quality change to either. One component
  at a time.
- **Never re-auditing existing scaffolding when models get better.** Capability improvements accrue quietly.
  A component that was essential for an older model may be transparently handled by a newer one. Without an
  explicit re-audit cadence, the harness ossifies around old assumptions.
