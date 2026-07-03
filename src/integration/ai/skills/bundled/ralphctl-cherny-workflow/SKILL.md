---
name: ralphctl-cherny-workflow
description: Session-discipline skill — settle the plan before touching code, work in small verified increments with a feedback loop that proves each change works, and record corrections so the same mistake is not repeated. Use when executing multi-step coding tasks where batching unverified work would compound risk; bundles plan-first sequencing and learning capture on top of the narrower per-change habits in ralphctl-iterative-review and (when installed) ralphctl-karpathy-guidelines.
---

# Cherny Workflow

> Distilled from Boris Cherny's (creator of Claude Code) publicly shared workflow practices —
> his January 2026 ["How I use Claude Code" thread](https://x.com/bcherny/status/2007179832300581177).
> Clean-room — concepts only, not copied text; interactive-only tips (parallel terminals,
> permission tuning, editor integration) are deliberately omitted.

Two habits carry most of the value of this workflow: separate planning from execution, and give
every change a way to prove itself. Cherny's strongest claim is about the second — a working
verification loop multiplies the quality of the final result, because each increment is either
demonstrated or rolled back while it is still small.

## When this applies

- **Execute** — the primary home: any task with more than one meaningful step, and any change where "did that actually work?" has a checkable answer.
- **Create PR** — the summary step: the description writes itself when the work was a sequence of verified increments instead of one opaque batch.

## Plan before code

- Do not start editing until the plan is settled: which files change, in what order, and what proves each step worked. When the task arrives with a plan or acceptance criteria, restate them as your working plan; when it doesn't, write the plan as your first output.
- Going back and forth on the plan is cheap; going back and forth on a half-applied diff is not. Revise the plan while it is still words.
- Once the plan is settled, execution should be unremarkable — a step that surprises you is a signal to stop and re-plan, not to improvise forward.

## The verification loop

- Before each step, know its check: the test that should pass, the command that should exit cleanly, the behaviour that should be observable. A step without a check is not ready to execute.
- Run the check immediately after the step — never accumulate several unverified steps, because a late failure then points at all of them at once.
- Prefer the narrowest check that can falsify the step (one test file, one build target, one focused run) over broad suites; breadth comes at the end, and the harness owns the final post-task verify gate.
- When no automated check exists for a step, create the smallest one that would fail if the step were wrong — or state explicitly in a `<note>` signal that the step is unverified and why.

## Small verified increments

- Shape the work so that after every increment the project is in a working state — each one a checkpoint the harness can capture, not a stretch of shared broken ground.
- If an increment cannot be made safely small (a rename that touches everything, a schema change), isolate it as its own step with its own check, and keep unrelated edits out of it.
- Re-read your own diff at each checkpoint: is everything in it intentional, and does anything in it belong to a different step?

## Compounding corrections

- When you discover a project-specific gotcha — a convention that contradicted your instinct, a command that behaves unexpectedly, a fix for a recurring failure — record it as a `<learning>` signal so it persists beyond this session.
- The habit mirrors how Cherny's team maintains their agent-facing project docs: every observed mistake becomes a written correction, so the same steering is never needed twice.
- Record the correction at the moment you learn it — deferred notes don't get written; the exception is mid-verification, where finishing the check comes first.

## Anti-patterns

- **Code-first sessions.** Editing before the plan exists, then discovering the approach was wrong three files in.
- **Batch-then-pray.** Making five changes and running one big check at the end — the failure points everywhere and nowhere.
- **Checkless steps.** "This one's trivial" is how unverified changes slip through; trivial steps have trivial checks.
- **Silent re-learning.** Hitting the same project quirk twice because the first encounter was never recorded.
- **Plan drift.** Quietly doing something other than the settled plan; when reality invalidates the plan, update it visibly first.

## Self-check before finishing

- [ ] The executed steps match the settled plan — or the plan was explicitly revised along the way.
- [ ] Every step's check ran and passed at the time the step was made.
- [ ] The final diff reads as a sequence of intentional increments, with nothing unexplained.
- [ ] Any durable gotcha discovered this session was recorded as a `<learning>` signal.
