---
name: ralphctl-iterative-review
description: Cross-phase skill — treat AI output as a controlled feedback loop, not a one-shot generation. Run the cheap check after each meaningful change; re-read your own output before signalling completion.
---

# Iterative Review

> Concept
>
> from [Martin Fowler — "Iterative Review"](https://martinfowler.com/articles/structured-prompt-driven/iterative-review.html).
> Adapted for ralphctl's three phases.

One-shot generation looks fast and is slow. The cheap review you skipped at iteration N becomes the expensive
unwind at iteration N+5, when a regression that lived undetected through five steps surfaces only at the
post-task gate. Catching a problem at the seam between two changes is cheap; catching it at the end of a
200-line diff is not. The harness's check gate, the evaluator, and the review prompts are this loop in
deployed form — but the same posture also belongs **inside** each phase's work.

## When this applies

- **Refine** — re-read the drafted criteria once against the ticket before sending. Strike duplicates;
  tighten "should" / "ideally" into checkable predicates. Cheap to do here, expensive once planning splits
  tasks against the unclear version.
- **Plan** — re-read the generated task list against the requirements. Are the tasks independently
  shippable? Do dependencies match the actual data flow? Reorder, merge, or drop before importing.
- **Execute** — run the project's check gate (lint, typecheck, tests) after each meaningful change, not
  after the whole diff. Re-read your own diff once before signalling `<task-complete>`. You are the cheapest
  reviewer the change ever gets.

## What to do

1. **Run the cheapest check first, often.** Lint, typecheck, narrow test runs — not the full suite — after
   each meaningful change. The point is to catch the regression at the seam, not to certify completion.
2. **Re-read your own output once before submitting.** Whether it is criteria, tasks, or a diff, the second
   read catches what the first one missed. Cheap.
3. **Treat the check gate as a loop, not a finish line.** A failing gate is feedback, not a verdict. Apply
   the fix and re-run; do not signal completion against a red gate.
4. **When a fix attempt repeats the same failure, escalate rather than retry.** Two iterations of the same
   error is a plateau — the next fix is a guess. Surface the blocker via `<task-blocked>` or `<note>` rather
   than burning the budget.

## Anti-patterns

- **Heroic one-shot.** Drafting 200 lines, signalling complete, and discovering at the gate that lint
  rejects every other line. The harness will catch it; the cost is the whole iteration.
- **Patching code without updating the prompt / spec.** Drift between the artefact and the spec accumulates
  silently and shows up later as inexplicable behaviour no one can trace.
- **Treating the post-task gate as the only review.** It is the _last_ review, not the only one. Anything
  the gate catches that you could have caught earlier is wasted budget.
- **Re-running the same fix unchanged.** If the same critique surfaces twice, the third attempt is not a
  fix — it is hope. Plateau out and surface it.
