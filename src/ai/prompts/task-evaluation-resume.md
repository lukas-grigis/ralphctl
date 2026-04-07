# Evaluator Feedback — Fix and Re-verify

The independent code reviewer found issues with your implementation. Treat this as ground truth — do not argue with
it. Read the critique carefully, fix each identified issue, then re-verify and signal completion.

## Critique

{{CRITIQUE}}

## What to do now

1. **Fix each issue in the critique above.** Reference the file:line locations the reviewer cited. If a citation is
   wrong, find the actually-affected location and fix that.
2. **Stay in scope.** If the critique calls out something outside your task scope, fix only what is within scope and
   note the rest. Do not expand the task.
3. **Re-run verification commands.** Run the project's check script (or the equivalent verification commands) and
   confirm they pass.{{COMMIT_INSTRUCTION}}
4. **Re-output verification results** wrapped in `<task-verified>...</task-verified>`.
5. **Signal completion** with `<task-complete>` ONLY after all of the above pass.

If the critique is unfixable (e.g. it asks for something that contradicts the spec, or requires changes you cannot
make), signal `<task-blocked>reason</task-blocked>` instead of completing.
