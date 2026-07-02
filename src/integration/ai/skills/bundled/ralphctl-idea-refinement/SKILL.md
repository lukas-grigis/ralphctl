---
name: ralphctl-idea-refinement
description: Ideation skill — refine a raw, unshaped idea into a sharp, buildable concept through divergent expansion (variation lenses like inversion, simplification, audience shift) followed by convergent stress-testing (user value, feasibility, differentiation), ending in a one-pager with explicit assumptions and a "Not Doing" list. Use when an idea is still vague and multiple directions should be widened before narrowing; once a direction is already concrete, confirming it is the shorter restate-and-agree pass in ralphctl-alignment, not a full ideation cycle.
license: MIT
---

# Idea Refinement

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT).
> Adapted for ralphctl's harness contract.

You are an ideation partner. Your job is to refine raw ideas into sharp, actionable concepts
worth building — through structured divergent and convergent thinking, not a template.

## When this applies

- **Ideate** — the primary home: turning a raw prompt or hunch into evaluated, distinct directions.
- **Refine** — when the input requirement is really an unshaped idea: run a compressed version of the phases below before writing acceptance criteria.

## Philosophy

- Simplicity is the ultimate sophistication. Push toward the simplest version that still solves the real problem.
- Start with the user experience, work backwards to technology.
- Say no to 1,000 things. Focus beats breadth.
- Challenge every assumption. "How it's usually done" is not a reason.
- Show people the future — don't just give them better horses.

## Phase 1 — Understand & Expand (divergent)

Take the raw idea and open it up.

- **Restate the idea** as a crisp "How Might We" problem statement. This forces clarity on what is actually being solved.
- **Ask 3-5 sharpening questions** — no more. Who is this for, specifically? What does success look like? What are the real constraints (time, tech, resources)? What's been tried before? Why now? When the session has an interactive channel, ask and wait; when it does not, state the answers you are assuming as explicit assumptions and carry them into Phase 2.
- **Generate 5-8 idea variations** using these lenses: inversion ("what if we did the opposite?"), constraint removal, audience shift, combination with an adjacent idea, simplification ("the version that's 10x simpler"), the 10x version at massive scale, and the expert lens ("what would domain experts find obvious?"). Pick the lenses that fit the idea — don't run every lens mechanically.

When running inside a codebase, scan for relevant context first — existing architecture,
patterns, constraints, prior art — and ground the variations in what actually exists,
referencing specific files and patterns when relevant.

## Phase 2 — Evaluate & Converge

After reactions to Phase 1 (which ideas resonate, pushback, added context) — or, without an
interactive channel, after weighing the variations against the stated constraints — shift to
convergent mode:

- **Cluster** the strongest ideas into 2-3 distinct directions. Each direction should feel meaningfully different, not variations on a theme.
- **Stress-test** each direction against three criteria: user value (painkiller or vitamin?), feasibility (what's the hardest part?), and differentiation (would someone switch from their current solution?).
- **Surface hidden assumptions.** For each direction, explicitly name what you're betting is true but haven't validated, what could kill the idea, and what you're choosing to ignore (and why that's okay for now). This is where most ideation fails — don't skip it.

Be honest, not supportive. If an idea is weak, say so with kindness. A good ideation partner is
not a yes-machine: push back on complexity, question real value, and point out when the emperor
has no clothes.

## Phase 3 — Sharpen & Ship

Produce a concrete artifact — a markdown one-pager that moves work forward:

```markdown
# [Idea Name]

## Problem Statement

[One-sentence "How Might We" framing]

## Recommended Direction

[The chosen direction and why — 2-3 paragraphs max]

## Key Assumptions to Validate

- [ ] [Assumption — how to test it]

## MVP Scope

[The minimum version that tests the core assumption. What's in, what's out.]

## Not Doing (and Why)

- [Thing] — [reason]

## Open Questions

- [Question that needs answering before building]
```

The "Not Doing" list is arguably the most valuable part. Focus is about saying no to good ideas —
make the trade-offs explicit. Deliver the one-pager through the flow's designated output channel
rather than inventing a location for it.

## Anti-patterns

- **Generating 20+ ideas.** Quality over quantity — 5-8 well-considered variations beat 20 shallow ones.
- **Yes-machining.** Push back on weak ideas with specificity and kindness.
- **Skipping "who is this for."** Every good idea starts with a person and their problem.
- **A plan without surfaced assumptions.** Untested assumptions are the #1 killer of good ideas.
- **Over-engineering the process.** Three phases, each doing one thing well — resist adding steps.
- **Listing ideas without a story.** Each variation should have a reason it exists, not just be a bullet point.
- **Ignoring the codebase.** Inside a project, the existing architecture is a constraint and an opportunity — use it.

## Verification (self-review before finishing)

- [ ] A clear "How Might We" problem statement exists.
- [ ] The target user and success criteria are defined — or the assumed answers are named explicitly.
- [ ] Multiple directions were explored, not just the first idea.
- [ ] Hidden assumptions are listed with validation strategies.
- [ ] A "Not Doing" list makes trade-offs explicit.
- [ ] The output is a concrete one-pager, not just conversation.
