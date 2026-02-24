# RalphCTL - Acceptance Criteria

Testable acceptance criteria for all features. For constraints, see the root CLAUDE.md. For data models, see [ARCHITECTURE.md](./ARCHITECTURE.md).

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

## Task Execution

- [ ] Tasks execute in dependency order
- [ ] Independent tasks run in parallel (one per projectPath)
- [ ] `in_progress` tasks resume on restart
- [ ] Completion signals parsed correctly
- [ ] Blocked tasks pause execution
- [ ] Verification required before completion (headless mode)
- [ ] Pre-existing verification catches broken state
- [ ] Verification results stored in task
- [ ] Rate-limited tasks auto-resume via session ID
- [ ] Structured exit codes for scripting integration

## Multi-Project Support

- [ ] Projects can have multiple repositories
- [ ] Tickets reference projects by name
- [ ] Tasks get projectPath from ticket's project
- [ ] Each task executes in its assigned project path
