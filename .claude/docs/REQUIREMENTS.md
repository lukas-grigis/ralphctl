# RalphCTL - Acceptance Criteria

Testable acceptance criteria for all features. For constraints, see the root CLAUDE.md. For data models,
see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Project Lifecycle

- [ ] Projects have unique slug names
- [ ] Projects require at least one repository
- [ ] Repository paths are validated as existing directories
- [ ] Projects can be removed only if not referenced by tickets

## Sprint Lifecycle

- [ ] New sprint starts as `draft`
- [ ] Only `draft` sprints can have tickets/tasks added
- [ ] `sprint start` auto-activates draft sprints
- [ ] Multiple sprints can be `active` at a time (parallel usage)
- [ ] Only `active` sprints can have task status updated
- [ ] `closed` sprints cannot be modified
- [ ] Sprint closure warns if tasks incomplete

## Ticket Flow

- [ ] Tickets require `projectName` referencing existing project
- [ ] Tickets get auto-generated internal `id`
- [ ] `requirementStatus` starts as `pending`
- [ ] `sprint refine` clarifies requirements (no code exploration)
- [ ] `sprint refine` sets `requirementStatus` to `approved`
- [ ] `sprint plan` proposes affected repos based on requirements
- [ ] `sprint plan` requires all tickets `approved`
- [ ] Repository selection saved to `ticket.affectedRepositories` during planning
- [ ] `sprint ideate` creates ticket and generates tasks in one session

## Incremental Planning (Re-plan)

- [ ] `sprint plan` auto-detects existing tasks — no special flag needed
- [ ] When tasks exist, all tickets AND existing tasks are passed as AI context
- [ ] AI generates a complete task set (can modify, update, reorder, or add tasks)
- [ ] Imported tasks replace all existing tasks (safe — draft tasks are always `todo`)
- [ ] Re-plan stays draft-only — no active sprint relaxations
- [ ] `reorderByDependencies` runs after every import (initial or re-plan)
- [ ] Duplicate task order numbers are detected by `sprint health`

## Task Execution

- [ ] Tasks execute in dependency order
- [ ] Independent tasks run in parallel (one per projectPath)
- [ ] `in_progress` tasks resume on restart
- [ ] Completion signals parsed correctly
- [ ] Blocked tasks pause execution
- [ ] Verification required before completion (headless mode)
- [ ] `checkScript` runs at sprint start
- [ ] `checkScript` runs after every task completion as a post-task gate
- [ ] Task not marked done if check gate fails
- [ ] Rate-limited tasks auto-resume via session ID
- [ ] Structured exit codes for scripting integration

## Branch Management

- [ ] `sprint start` prompts for branch strategy on first run (keep current, auto, custom)
- [ ] `--branch` flag auto-generates `ralphctl/<sprint-id>` branch name
- [ ] `--branch-name <name>` sets a custom branch name
- [ ] Branch is created in all repos with remaining tasks
- [ ] Uncommitted changes in any repo fail-fast before branch creation
- [ ] Branch name persisted to `sprint.branch` for resume
- [ ] Subsequent runs skip prompt and use saved branch
- [ ] Pre-flight branch verification before each task execution
- [ ] `sprint show` displays branch when set
- [ ] `sprint health` checks branch consistency across repos
- [ ] `sprint close --create-pr` creates PRs for sprint branches
- [ ] Agent context includes branch section telling agent which branch it's on

## Doctor (Environment Health)

- [ ] Checks Node.js version >= 24.0.0
- [ ] Checks `git` is installed and in PATH
- [ ] Warns (not fails) when git identity (`user.name`/`user.email`) is missing
- [ ] Checks configured AI provider binary (`claude` or `copilot`) is in PATH
- [ ] Skips AI provider check when no provider is configured
- [ ] Verifies data directory is accessible and writable
- [ ] Validates all registered project repository paths exist and are git repos
- [ ] Validates current sprint file exists and parses correctly
- [ ] Skips sprint check when no current sprint is set
- [ ] Sets non-zero exit code on failures (warnings don't affect exit code)

## Multi-Project Support

- [ ] Projects can have multiple repositories
- [ ] Tickets reference projects by name
- [ ] Tasks get projectPath from ticket's project
- [ ] Each task executes in its assigned project path
