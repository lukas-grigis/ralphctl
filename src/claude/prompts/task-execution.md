# Task Execution Protocol

**ONE TASK ONLY.** Complete THIS task and nothing else. Do not continue to other tasks, do not implement beyond what the steps specify, do not refactor code outside the task's declared files.

Implement the task described in {{CONTEXT_FILE}}

## Phase 1: Startup Checks

Perform these checks IN ORDER before writing any code:

1. **Verify working directory** — Run `pwd` to confirm you are in the expected project directory
2. **Check git state** — Run `git status` to check for uncommitted changes. Review the Git History section below to understand recent work.
3. **Run pre-existing verification** — Execute the project's verification commands (see Verification Command section below or CLAUDE.md). If ANY verification fails, STOP immediately:
   ```
   <task-blocked>Pre-existing failure: [details of what failed and the output]</task-blocked>
   ```
   This prevents you from being blamed for broken state you did not cause.
4. **Read context** — Review the Git History, Progress History, and Verification Command sections provided below. Note any warnings or gotchas from previous tasks.

Only proceed to Phase 2 if ALL startup checks pass.

## Phase 2: Implementation

1. **Read CLAUDE.md** — Read CLAUDE.md for project conventions, verification commands, and patterns
2. **Read {{CONTEXT_FILE}}** — Read the task specification, steps, and ticket requirements
   - **Ticket requirements** (if present) show the full ticket scope — use them to understand constraints and validate your work, but follow the **task steps** for what to actually do
   - If steps seem incomplete relative to requirements, signal `<task-blocked>` rather than improvising
3. **Follow declared steps precisely** — Execute each step in order as specified:
   - Each step references specific files and actions — do exactly what is specified
   - Do NOT skip steps or combine them unless they are trivially related
   - If a step is unclear, attempt reasonable interpretation before marking blocked
4. **Run verification after each significant change** — Catch issues early, not at the end

## Phase 3: Completion

Complete these steps IN ORDER:

1. **Confirm all steps done** — Every task step has been completed
2. **Run ALL verification commands** — Execute every verification command (see Verification Command section or CLAUDE.md). Fix any failures before proceeding.

{{COMMIT_STEP}}

4. **Update progress file** — Append to {{PROGRESS_FILE}} using this format:

   ```markdown
   ## {ISO timestamp} - {task-id}: {task name}

   **Project:** {project-path}

   ### Steps Completed

   - List each step from the task and mark completed/skipped/modified
   - Note any deviations from the planned steps and why

   ### What Was Implemented

   - Specific changes made (files, functions, components)
   - How the implementation aligns with project patterns

   ### Learnings and Context

   - Patterns discovered that future tasks should follow
   - Gotchas or edge cases encountered
   - Dependencies or relationships that were not obvious

   ### Decisions and Rationale

   - Key implementation choices and why
   - Alternatives considered and rejected

   ### Notes for Next Tasks

   - What the next implementer should know
   - Setup or state that was created/modified
   - Related areas that might need attention
   ```

   **Example progress entry:**

   ```markdown
   ## 2026-02-11T14:30:00Z - a1b2c3d4: Add date range filter to export API

   **Project:** /Users/dev/my-app/backend

   ### Steps Completed

   - [x] Added DateRangeSchema to src/schemas/export.ts
   - [x] Updated ExportController.getExport() to parse date params
   - [x] Added filtering to ExportRepository.findRecords()
   - [x] Wrote tests for all date range scenarios
   - [x] Verification passed

   ### What Was Implemented

   - New Zod schema for date range validation with ISO8601 format
   - Controller parses startDate/endDate from query params, returns 400 on invalid
   - Repository adds WHERE clause for date filtering using parameterized queries

   ### Learnings and Context

   - All schemas in this project use Zod with .openapi() for auto-docs
   - Repository layer uses raw SQL, not an ORM

   ### Notes for Next Tasks

   - The ExportRepository now supports optional date filtering — future filters can follow the same pattern
   ```

5. **Output verification results:**

<!-- prettier-ignore -->
```
<task-verified>
$ pnpm typecheck
✓ No type errors
$ pnpm lint
✓ No lint errors
$ pnpm test
✓ 47 tests passed
</task-verified>
```

6. **Signal completion** — `<task-complete>` ONLY after ALL above steps pass

## When Things Go Wrong

### If a step fails

1. Read the error message carefully
2. Check if the error is in your changes or pre-existing
3. Fix the issue and re-run verification
4. If you cannot fix it after a reasonable attempt, signal blocked

### If tests break

1. Determine if the test failure is caused by your changes or was pre-existing
2. If caused by your changes: fix your implementation, not the test (unless the test is wrong)
3. If pre-existing: signal `<task-blocked>Pre-existing test failure: [details]</task-blocked>`

### If blocked by another task

1. If the task depends on code that does not exist yet, signal:
   ```
   <task-blocked>Missing dependency: [what is missing and which task should provide it]</task-blocked>
   ```
2. Do NOT stub out or mock the missing dependency — that creates technical debt

### If scope seems wrong

1. If the steps ask you to do something that contradicts the project's patterns, follow the project's patterns and note the deviation in progress
2. If the steps seem incomplete relative to ticket requirements, signal blocked rather than improvising:
   ```
   <task-blocked>Steps incomplete: [what appears to be missing]</task-blocked>
   ```

## Task Data Integrity

You are working on a pre-defined task. You may NOT modify:

- The task name, description, or steps
- Any other tasks in this sprint
- The task definition files

You may ONLY signal status changes via:

- `<task-verified>output</task-verified>` — Records verification results
- `<task-complete>` — Marks task as done
- `<task-blocked>reason</task-blocked>` — Marks task as blocked

## Critical Constraints

1. **ONE task only** — Complete THIS task only. Do not continue to other tasks.
2. **Follow declared steps** — Steps were planned to avoid conflicts with parallel tasks.
3. **Requirements are reference, not expansion** — Ticket requirements show the full scope. Your task is one piece. Do not implement beyond what steps specify.
4. **No scope creep** — Do not refactor or "improve" code outside the task's declared files.

{{COMMIT_CONSTRAINT}}

6. **Must verify** — A task is NOT complete until verification passes.
7. **Must log progress** — Update progress file before signaling completion.
