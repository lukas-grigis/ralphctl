Implement the task described in .ralphctl-task-context.md

## Session Startup Protocol

BEFORE implementing anything, perform these checks:

1. **Verify working directory**
   - Run `pwd` to confirm you're in the expected project directory

2. **Check git state**
   - Run `git status` to check for uncommitted changes
   - Review the Git History section below to understand recent work

3. **Run pre-existing verification**
   - Execute the project's verification commands (see Verification Command section below or CLAUDE.md)
   - If ANY verification fails, STOP and output:
     `<task-blocked>Pre-existing failure: [details]</task-blocked>`
   - This prevents inheriting blame for broken state

4. **Review context sections** (provided below)
   - Git History: Recent commits in this project
   - Progress History: What previous tasks accomplished
   - Note any warnings or gotchas mentioned

Only proceed to implementation if all startup checks pass.

## Execution Protocol

1. **Read context first**
   - Read CLAUDE.md for project conventions, verification commands, and patterns
   - Read .ralphctl-task-context.md for the task specification and requirements

2. **Follow declared steps precisely**
   - The task includes specific implementation steps - follow them in order
   - Each step references specific files and actions - do exactly what is specified
   - Do NOT skip steps or combine them unless they are trivially related
   - If a step is unclear, attempt reasonable interpretation before marking blocked

3. **Run all verification steps**
   - The task steps include project-specific verification commands
   - Run every verification step and ensure it passes
   - Fix any failures before proceeding to the next step

4. **Append progress to {{PROGRESS_FILE}}**

   ## {ISO timestamp} - {task-id}: {task name}

   **Project:** {project-path}

   ### Steps Completed
   - List each step from the task and mark completed/skipped/modified
   - Note any deviations from the planned steps and why

   ### What was implemented
   - Specific changes made (files, functions, components)
   - How the implementation aligns with project patterns

   ### Learnings & Context
   - Patterns discovered that future tasks should follow
   - Gotchas or edge cases encountered
   - Dependencies or relationships that weren't obvious
   - Technical debt identified (but not addressed)

   ### Decisions & Rationale
   - Key implementation choices and why
   - Alternatives considered and rejected
   - Trade-offs accepted

   ### Notes for next tasks
   - What the next implementer should know
   - Setup or state that was created/modified
   - Related areas that might need attention

{{COMMIT_INSTRUCTION}}## Completion Protocol

You MUST complete these steps IN ORDER:

1. **Implementation complete** - All task steps are done
2. **Run verification** - Execute ALL verification commands (see Verification Command section or CLAUDE.md)
3. **Commit changes** - Create a git commit with a descriptive message
4. **Update progress** - Append to the progress file (format above)
5. **Output verification results:**
   ```
   <task-verified>
   $ [lint command]
   ✓ No lint errors
   $ [test command]
   ✓ All tests passed
   </task-verified>
   ```
6. **Signal completion** - `<task-complete>` ONLY after all above steps pass

If verification fails:

- Fix the issue and re-run verification
- Do NOT output `<task-complete>` until verification passes

If you cannot fix the issue:

- Output `<task-blocked>reason</task-blocked>`

## Task Data Integrity

You are working on a pre-defined task. You may NOT modify:

- The task name, description, or steps
- Any other tasks in this sprint
- The task definition files

You may ONLY signal status changes via:

- `<task-complete>` - marks task as done
- `<task-blocked>reason</task-blocked>` - marks task as blocked
- `<task-verified>output</task-verified>` - records verification

This prevents accidental loss of planned work or requirements.

## Critical Constraints

1. **ONE task only** - Complete THIS task only. Do not continue to other tasks.
2. **Follow declared steps** - Steps were planned to avoid conflicts with parallel tasks.
3. **No scope creep** - Do not refactor or "improve" code outside the task's declared files.
4. **Must verify** - A task is NOT complete until verification passes.
5. **Must commit** - Create a git commit before signaling completion.
6. **Must log progress** - Update progress file before signaling completion.

These constraints prevent:

- Early victory declarations (completing tasks that aren't actually done)
- Untracked changes (work that future agents won't know about)
- Scope expansion (doing more than requested, causing conflicts)
