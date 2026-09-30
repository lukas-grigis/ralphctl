---
name: step_trace_locations
description: Where chain step traces are documented, which flows have no trace outside the code, and why the flow's tests (not the docs) are the source of truth
metadata:
  type: reference
---

Step traces are the fastest-drifting prose in the docs. New leaves land in fix/prompt/TUI commits that don't announce a
chain-shape change, so reviewers miss the trace update. Procedure lives in the `flow-trace-sync` skill; this note
records where the traces are and the traps.

**Source of truth:** the flow's e2e test `tests/e2e/flows/<flow>.test.ts` (asserted trace), or the topology fence
where one exists: `tests/unit/application/flows/plan/flow-shape.test.ts` for plan,
`tests/integration/application/flows/implement/leaves/gen-eval-loop.test.ts` for the gen-eval turn and evaluator-guard
child order. Docs follow the tests, never the reverse.

**Doc locations (grep each on every audit; headings verified against the current files):**

- `REQUIREMENTS.md` `## Implement flow`: the `start-attempt → … → progress-journal` attempt-body checkbox.
- `REQUIREMENTS.md` `## Two-Phase Planning`, `## Review flow (apply-feedback)`, `## Doctor` list behaviours and status transitions, not step traces; don't hunt for traces there.
- `KERNEL-DESIGN.md` `## Examples` (`### refineFlow`, `### implementFlow`): code-block traces.
- `WORKFLOWS.md`: prose walkthroughs (for plan, the `Two-phase planning` paragraph).
- `.claude/docs/diagrams/*.md`: sequence and data-flow diagrams.
- `ARCHITECTURE.md` `### Flows and their nature` is a registry table with no traces; do not expect one per chain.

**Trap:** `plan` has a REQUIREMENTS checkbox and an ARCHITECTURE registry row, but no step trace in either; its only
trace home is the WORKFLOWS.md `Two-phase planning` paragraph plus the flow-shape fence. A leaf added to `plan/flow.ts`
means checking those two, not hunting for a trace elsewhere. Sequential composites emit
no trace entry of their own, only leaves do.
