---
name: abstraction-first
description: Cross-phase skill — design the shape of the change (entities, boundaries, seams) before generating code, tasks, or acceptance criteria. Failure mode is "big blob" output that obscures the core change.
---

# Abstraction-First

> Concept from [Martin Fowler — "Abstraction-First"](https://martinfowler.com/articles/structured-prompt-driven/abstraction-first.html). Adapted for ralphctl's three phases.

The shape of the change comes before the words that describe it. Name the entities, the boundaries, and the
seams the change touches **first**; the criteria, tasks, or code that follow are then arguments about that
shape, not freeform prose. Skip this and the output reads as a "big blob" — duplicated logic, blurred
responsibilities, work that has to be reviewed wholesale rather than incrementally.

## When this applies

- **Refine** — name the entities and the boundary of the change before listing acceptance criteria. "Adds a
  `UserBilling` aggregate that exposes `cancelSubscription`" is the right altitude. "The cancel button must
  turn red" is too specific to be the spec.
- **Plan** — sketch which existing components the change extends, which new ones it introduces, and the seams
  between them, before splitting into tasks. The task list is then the decomposition of a known shape, not a
  guess about one.
- **Execute** — re-read the task's verification criteria and the surrounding code's existing pattern before
  opening an editor. The "abstraction" at this altitude is the contract the task already declared; matching it
  is the job.

## What to do

1. **Name the entities.** Real-world nouns the change talks about — domain objects, aggregates, modules,
   external systems. If you cannot name three of them, the change is either trivial or under-specified.
2. **Draw the boundary.** Which files / directories / packages are in scope? Which are explicitly out? An
   ambiguous boundary is the same problem as an ambiguous criterion — it lets later work drift.
3. **Identify the seam.** Where does the new behaviour meet the existing system? An interface, a port, a
   route, a CLI command, a database table. The seam is where regressions hide; call it out by name.
4. **Only then describe behaviour.** Acceptance criteria, task steps, code — all of these are downstream of
   the shape. Writing them first is what produces the "big blob".

## Anti-patterns

- **Specifying behaviour before naming entities** — produces criteria that read as a wishlist rather than a
  spec. Reviewers cannot tell what the change actually _is_.
- **Listing files instead of naming a boundary** — "touches `foo.ts`, `bar.ts`, `baz.ts`" is not a boundary;
  it is a side effect of one. Name the module or aggregate they belong to.
- **Inventing an abstraction the codebase does not have** — if the existing code has no `UserBilling`
  aggregate, do not name one in the spec unless creating it is part of the change.
