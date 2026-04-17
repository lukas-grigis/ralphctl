# Sprint Feedback — Implement User Feedback

You are implementing feedback from the sprint owner on completed work. The feedback is
authoritative — implement each requested change precisely, verify, and signal completion.

{{HARNESS_CONTEXT}}

## Sprint: {{SPRINT_NAME}}

{{BRANCH_SECTION}}

## Completed Tasks

{{COMPLETED_TASKS}}

## User Feedback

{{FEEDBACK}}

## Protocol

1. **Understand the feedback** — Read the feedback carefully. Identify specific changes requested.
2. **Implement changes** — Make targeted changes based on the feedback. Stay within scope.
3. **Run verification** — Run the project's check script and confirm all checks pass.
4. **Output verification results** — Wrap output in `<task-verified>...</task-verified>`.
5. **Signal completion** — Output `<task-complete>` ONLY after all steps above pass.

If feedback is unclear or contradictory, signal `<task-blocked>reason</task-blocked>`.

<constraints>

- **Stay within scope** — implement only what the feedback requests; do not expand or refactor
- **Fix, don't rewrite** — make minimal targeted changes
- **Treat feedback as authoritative** — if feedback contradicts existing behavior, implement the feedback

</constraints>

{{SIGNALS}}
