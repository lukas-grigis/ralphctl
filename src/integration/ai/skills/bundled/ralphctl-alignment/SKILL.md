---
name: ralphctl-alignment
description: Cross-phase skill — establish a shared understanding of what will and will not be done before producing output. Restate the input back to the user; surface assumptions; agree before you write.
---

# Alignment

> Concept from [Martin Fowler — "Alignment"](https://martinfowler.com/articles/structured-prompt-driven/alignment.html). Adapted for ralphctl's three phases.

The fastest way to ship the wrong thing is to start producing output before you have agreed on what is being
asked. Alignment is the discipline of restating the input, surfacing assumptions, and naming the non-goals
**before** the work begins. The cost of pausing to confirm is one round-trip; the cost of unwound output is
the whole change.

## When this applies

- **Refine** — refinement is itself an alignment exercise. Restate the ticket in one paragraph; list the
  assumptions you would have to make to implement it; agree before drafting acceptance criteria. A criterion
  built on a wrong premise is worse than a missing one.
- **Plan** — confirm the planner's read of the requirements before generating tasks. Repo selection, scope
  boundaries, and dependency assumptions all need to land before task decomposition starts.
- **Execute** — re-read the task spec's verification criteria before writing code. The contract is the
  arbiter; if your read of it differs from what's written, surface the conflict in a `<note>` rather than
  guessing.

## What to do

1. **Restate the input.** One paragraph. What you understood, in your own words. The user corrects the
   restatement before you spend their time on questions or output built on a wrong premise.
2. **List the assumptions.** Every implicit choice you would have to make to produce output — preferred
   library, naming convention, error handling, scope boundary. Each one is a candidate for confirmation.
3. **Name the non-goals.** What is _out_ of scope is as load-bearing as what is _in_. Without explicit
   non-goals, scope creep is the default.
4. **Agree before producing output.** Do not draft criteria, tasks, or code while the restatement and
   assumptions are still open. If the input cannot be restated, it is not yet refined enough to plan.

## Anti-patterns

- **Asking what the ticket already answers.** A question the input already addresses signals you did not
  read carefully — wasted round-trips erode the user's trust in the alignment loop.
- **Over-asking.** Three to six focused questions is typical; ten is interrogation. Group questions by
  topic; let the user answer in batches; stop when the criteria are unambiguous.
- **Skipping the restatement.** Going straight to "is this OK?" with output already drafted means the
  alignment is happening _after_ the work, where the cost of being wrong is highest.
- **Implementation talk during refinement.** Implementation choices belong to planning. Pulling them into
  the alignment phase is how scope drifts.
