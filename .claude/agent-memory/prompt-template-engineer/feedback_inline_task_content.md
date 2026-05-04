---
name: Inline task content in execute prompt
description: buildExecutePrompt must inline task fields directly — no context-file indirection; mirror buildEvaluatePrompt pattern
type: feedback
---

`buildExecutePrompt` previously passed `CONTEXT_FILE: ''` (empty) — the AI received the template with no task
name, no description, no steps, no verification criteria. This caused silent do-nothing runs and evaluator failures.

**Why:** Context-file indirection (writing a per-task file then pointing the prompt at it) is needless IO,
hard to test, and doesn't survive session-resume well. The evaluator template already did it right by inlining.

**How to apply:** Use these placeholders in `task-execution.md` and fill them in `buildExecutePrompt`:

- `TASK_NAME`, `PROJECT_PATH`, `BRANCH_SECTION`
- `TASK_DESCRIPTION_SECTION`, `TASK_STEPS_SECTION`, `VERIFICATION_CRITERIA_SECTION`
- `CHECK_SCRIPT_SECTION` (intentionally empty — harness runs the gate, not the AI)
- `PROGRESS_FILE` — absolute path via `resolveStoragePaths().sprintDir(sprint.id) + '/progress.md'`

Mirror the section-formatting convention from `buildEvaluatePrompt`:
`desc = task.description ? \`\n**Description:** ${task.description}\` : ''`
