# Sprint Feedback — Implement User Feedback

The sprint owner has sent you a concrete change request to carry out in this repository. Treat the **User Feedback**
block below as a direct instruction — a new piece of work to implement, not a review comment to reflect on. Read it
carefully, identify exactly which files need to be created or edited, apply the change, verify, and signal completion.

The completed-task list is context only — the feedback is **not** required to relate to it. If the feedback asks for
something entirely new (create a file, add a feature, tweak a script), do exactly that.

{{HARNESS_CONTEXT}}

## Sprint: {{SPRINT_NAME}}

{{BRANCH_SECTION}}

## Completed Tasks (context only — feedback is the authoritative instruction)

{{COMPLETED_TASKS}}

## User Feedback — Implement this

{{FEEDBACK}}

## Protocol

1. **Parse the feedback as an instruction** — Identify the concrete change(s) requested. If it says "create X", create
   X. If it says "change Y", change Y. Do not ask for clarification unless the instruction is genuinely contradictory.
2. **Implement the change** — Create or edit the files required to satisfy the feedback. Make the smallest change that
   fully carries out the instruction.
3. **Run verification** — If the project has a check script (e.g., `pnpm test`, `pnpm typecheck`), run it and confirm
   it passes. If no check script is configured, skip this step.
4. **Output verification results** — Wrap any verification output in `<task-verified>...</task-verified>`. If you
   skipped step 3, emit `<task-verified>no check script configured; change applied</task-verified>`.
5. **Signal completion** — Output `<task-complete>` once the change is applied and verification (if any) passed.

Only signal `<task-blocked>reason</task-blocked>` if the feedback is literally impossible to carry out (e.g., asks
you to edit a file in a repository you don't have access to). Ambiguity is **not** a blocker — make a reasonable
interpretation and proceed.

<constraints>

- **The feedback is the authoritative instruction** — implement it even if it seems unrelated to the completed tasks.
- **Do the smallest change that fully satisfies the feedback** — no speculative refactors, no adjacent cleanup.
- **Make the edits — don't just describe them** — the harness does not apply edits for you; you must write the files.

</constraints>

{{SIGNALS}}
