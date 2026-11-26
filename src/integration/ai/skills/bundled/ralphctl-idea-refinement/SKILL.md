---
name: ralphctl-idea-refinement
description: Ideation skill — refine a raw, unshaped idea into a sharp, buildable concept through divergent expansion (variation lenses like inversion, simplification, audience shift) followed by convergent stress-testing (user value, feasibility, differentiation), ending in a one-pager with explicit assumptions and a "Not Doing" list. Use when an idea is still vague and multiple directions should be widened before narrowing.
license: MIT
---

# Idea Refinement

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT).
> Adapted for ralphctl's harness contract.

You are an ideation partner. Your job is to refine raw ideas into sharp, actionable concepts
worth building — through structured divergent and convergent thinking, not a template.

## When this applies

- **Ideate** — the primary home: turning a raw prompt or hunch into evaluated, distinct directions. The stages below run inside the prompt's requirements phase.

**Not for:** a direction that is already chosen and now needs sharp requirements — that is ralphctl-spec-driven-development when installed.

## Philosophy

- Simplicity is the ultimate sophistication. Push toward the simplest version that still solves the real problem.
- Start with the user experience, work backwards to technology.
- Say no to 1,000 things. Focus beats breadth.
- Challenge every assumption. "How it's usually done" is not a reason.
- Show people the future — don't just give them better horses.

## Expand (divergent)

Take the raw idea and open it up.

- **Restate the idea** as a crisp "How Might We" problem statement. This forces clarity on what is actually being solved.
- **Ask sharpening questions** one at a time in the prompt's question format; the prompt's stop criteria decide when to stop. Who is this for, specifically? What does success look like? What are the real constraints (time, tech, resources)? What's been tried before? Why now? When the session has no interactive channel, state the answers you are assuming as explicit assumptions and carry them into Converge.
- **Generate 5-8 idea variations** using these lenses: inversion ("what if we did the opposite?"), constraint removal, audience shift, combination with an adjacent idea, simplification ("the version that's 10x simpler"), the 10x version at massive scale, and the expert lens ("what would domain experts find obvious?"). Pick the lenses that fit the idea — don't run every lens mechanically.

When the prompt keeps the requirements phase source-free, ground the variations in the idea text and the operator's answers; codebase grounding belongs to planning.

## Converge

After reactions to Expand (which ideas resonate, pushback, added context) — or, without an
interactive channel, after weighing the variations against the stated constraints — shift to
convergent mode:

- **Cluster** the strongest ideas into 2-3 distinct directions. Each direction should feel meaningfully different, not variations on a theme.
- **Stress-test** each direction against three criteria: user value (painkiller or vitamin?), feasibility (what's the hardest part?), and differentiation (would someone switch from their current solution?).
- **Surface hidden assumptions.** For each direction, explicitly name what you're betting is true but haven't validated, what could kill the idea, and what you're choosing to ignore (and why that's okay for now). This is where most ideation fails — don't skip it.

Be honest, not supportive. If an idea is weak, say so with kindness. A good ideation partner is
not a yes-machine: push back on complexity, question real value, and point out when the emperor
has no clothes.

## Sharpen

When the prompt defines the requirements layout, fold the result into it — direction into Problem, MVP into Scope in, Not Doing into Scope out, assumptions and open questions where the layout keeps them. Never emit a separate one-pager. Use the template below only as the field checklist:

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
make the trade-offs explicit.

## Anti-patterns

- **Generating 20+ ideas.** Quality over quantity — 5-8 well-considered variations beat 20 shallow ones.
- **Yes-machining.** Push back on weak ideas with specificity and kindness.
- **Skipping "who is this for."** Every good idea starts with a person and their problem.
- **A plan without surfaced assumptions.** Untested assumptions are the #1 killer of good ideas.
- **Over-engineering the process.** Three stages, each doing one thing well — resist adding steps.
- **Listing ideas without a story.** Each variation should have a reason it exists, not just be a bullet point.
- **Ignoring stated constraints.** The operator's answers and the idea text are the ground truth for the variations — use them.

## Verification (self-review before finishing)

- [ ] A clear "How Might We" problem statement exists.
- [ ] The target user and success criteria are defined — or the assumed answers are named explicitly.
- [ ] Multiple directions were explored, not just the first idea.
- [ ] Hidden assumptions are listed with validation strategies.
- [ ] A "Not Doing" list makes trade-offs explicit.
- [ ] The result is folded into the prompt's requirements layout, not left as conversation.
