# RalphCTL - Requirements & Design Rationale

Functional requirements documenting what RalphCTL does, why features exist, and the reasoning behind design decisions.

> **See also:** [ARCHITECTURE.md](./ARCHITECTURE.md) for technical implementation details.

## Purpose

RalphCTL bridges the gap between high-level planning and AI-assisted implementation. It solves the problem of:

1. **Context loss** - AI assistants lose context between sessions; ralphctl maintains persistent state
2. **Unstructured work** - Without planning, AI tends to solve immediate problems without considering the bigger picture
3. **Multi-project coordination** - Modern features often span multiple repositories; ralphctl tracks work across
   projects
4. **Specification drift** - What was planned vs what was built diverges; ralphctl maintains living documentation

## Provider Abstraction

RalphCTL supports multiple AI providers via a provider abstraction layer:

**Supported Providers:**

- **Claude Code** (`claude` CLI) — Anthropic's AI assistant
- **GitHub Copilot** (`copilot` CLI) — GitHub's AI assistant

**Design Decision:** Provider selection is global (stored in `config.json`), not per-sprint. This reflects the reality that users typically stick with one provider per development environment.

**Shared Infrastructure:**

- Both providers use the same prompt templates (stored in `src/ai/prompts/`)
- Both providers implement a common `ProviderAdapter` interface
- Provider-specific logic is isolated in `src/providers/`
- Provider resolution happens automatically on first use (prompts user to choose)

**Rationale:** Supporting multiple providers gives users flexibility while maintaining a consistent workflow. The abstraction layer ensures that adding future providers (e.g., Gemini, GPT) is straightforward.

## Core Concepts

### Why Projects?

**Problem:** Many features span multiple repositories (frontend, backend, shared libs). Tracking which repo each piece
of work targets is cumbersome.

**Solution:** Projects are named entities with one or more repositories:

- `name`: Slug identifier (e.g., `my-app`)
- `displayName`: Human-readable name
- `repositories[]`: Array of `Repository` objects — each with `name`, `path`, optional `setupScript`, optional
  `verifyScript`

**Design Decision:** Projects are defined once and referenced by name. This enables:

- Multi-repo tickets without repeating paths
- Consistent naming across sprints
- Easy path management when repos move
- Per-repository verification and setup scripts

### Why Repositories (not just Paths)?

**Problem:** Different repositories in a project may need different build/test commands. A flat `paths[]` array provides
no place to store per-repo configuration.

**Solution:** Each project contains `repositories[]` with structured metadata:

- `name`: Auto-derived from `basename(path)` — human-readable identifier
- `path`: Absolute filesystem path
- `setupScript?`: Command to prepare the repo environment (e.g., `npm install`)
- `verifyScript?`: Command to verify correctness (e.g., `npm test && npm run lint`)

**Verification Script Resolution** (priority order):

1. Explicit `verifyScript` from repository configuration
2. Auto-detected from project files (package.json, pyproject.toml, etc.)
3. CLAUDE.md discovery (fallback)

_Rationale:_ Structured repositories let ralphctl auto-detect and run the right verification commands per-repo during
task execution, without relying on the AI agent to guess.

### Why Sprints?

**Problem:** Work happens in bursts — a sprint, a feature set, a release. Without boundaries, tasks accumulate
indefinitely and context becomes stale.

**Solution:** Sprints are containers with lifecycle (draft → active → closed). They:

- Group related work together
- Have clear start/end points
- Prevent mixing unrelated work
- Enable focused execution

**Design Decision:** Multiple sprints can be `active` simultaneously (useful for parallel work in different terminals).

### Sprint State Machine

**Problem:** Operations should only be valid in certain states:

- Adding tickets during execution causes scope creep
- Starting work before planning leads to confusion
- Modifying closed sprints destroys history

**Solution:** Strict state transitions with operation constraints:

| State    | Allowed Operations                                             |
| -------- | -------------------------------------------------------------- |
| `draft`  | Add/remove tickets, refine requirements, ideate, plan, start\* |
| `active` | Execute tasks, update status, log, close                       |
| `closed` | Read-only (show, list, context)                                |

\*`sprint start` auto-activates draft sprints.

**Design Decision:** State constraints are enforced at the service layer with clear error messages and hints. Multiple
sprints can be active simultaneously (useful for parallel work in different terminals).

### Why Tickets?

**Problem:** Work requests come from different sources — issue trackers, conversations, ideas. They need refinement
before becoming actionable.

**Solution:** Tickets capture raw work requests with optional issue tracker integration. They:

- Have an auto-generated internal `id` (uuid8) for reliable referencing
- Support optional `externalId` for issue tracker links (JIRA-123, GH-456)
- Support freestyle descriptions for ad-hoc work
- Store refined specifications after the refine phase
- Reference which project each piece of work targets

**Design Decision:** Tickets reference projects by `projectName` (not path) because:

- Projects can have multiple paths
- Names are stable identifiers
- Paths can change without breaking tickets

### Why Two-Phase Planning?

**Problem:** Jumping straight from vague requirements to implementation leads to:

- Misunderstood requirements
- Rework when assumptions are wrong
- Tasks that conflict with each other
- Missing edge cases

**Solution:** Two distinct phases with user approval gates:

**Phase 1 — Requirements Refinement (`sprint refine`):**

Focus: **WHAT** needs to be done (implementation-agnostic)

- Claude asks clarifying questions about requirements and acceptance criteria
- User answers via selection UI
- User approves refined requirements
- Requirements stored in tickets for Phase 2
- **NO code exploration** — pure requirements gathering
- **NO repository selection** — deferred to Phase 2

_Rationale:_ The person requesting work often doesn't know implementation details. This phase focuses purely on
clarifying WHAT needs to be built, without getting distracted by HOW. Separating concerns prevents premature technical
decisions.

**Phase 2 — Task Generation (`sprint plan`):**

Focus: **HOW** it will be implemented

- Claude proposes which repositories are affected based on approved requirements
- User confirms repository selection (checkbox UI)
- Selection saved to `ticket.affectedRepositories`
- Claude explores ONLY the confirmed repos
- Creates dependency-ordered task breakdown
- Each task has precise steps referencing actual files

_Rationale:_ With clear requirements from Phase 1, Claude can make informed decisions about which repos to explore and
how to split the work. User confirmation prevents scope creep. Dependencies ensure correct execution order.

### Why Quick Ideation?

**Problem:** The full refine → plan pipeline is thorough but heavyweight for small ideas. Sometimes you just want to
describe an idea and get tasks generated quickly.

**Solution:** `sprint ideate` combines refinement and planning into a single Claude session:

- User provides an idea title, description, and target project
- Claude refines requirements AND generates tasks in one pass
- Creates a ticket and imports tasks automatically
- Supports both interactive and headless (`--auto`) modes

_Rationale:_ Not every piece of work needs formal requirements gathering. Quick ideation provides a fast path for
small-to-medium features while preserving the structured task output.

### Why Tasks Have Dependencies?

**Problem:** Tasks often have implicit ordering requirements:

- "Create utility" must happen before "use utility"
- "Add database schema" must happen before "write queries"
- Parallel work can conflict if not carefully planned

**Solution:** Explicit `blockedBy` relationships that:

- Are validated on import (no cycles, no missing references, no forward references)
- Automatically reorder tasks before execution
- Prevent starting blocked tasks

**Design Decision:** Dependencies use task IDs rather than implicit ordering because:

- Explicit is clearer than positional
- Supports DAG structures (multiple dependencies, parallel branches)
- Survives reordering operations
- Enables parallel execution of independent tasks

### Why Current Sprint vs Sprint Status?

**Problem:** Users need to:

- Work on different sprints without re-specifying IDs every command
- Have clear separation between "which sprint I'm targeting" and "sprint lifecycle state"
- Run multiple sprints in parallel (different terminals)

**Solution:** Two separate concepts:

| Concept            | Purpose                                          | Storage       |
| ------------------ | ------------------------------------------------ | ------------- |
| **Current Sprint** | Target for CLI commands (show, add ticket, etc.) | `config.json` |
| **Sprint Status**  | Lifecycle state (draft/active/closed)            | `sprint.json` |

- Current sprint is a convenience pointer stored in config
- Sprint status is part of the sprint's own state
- Multiple sprints can be `active` simultaneously (parallel terminal usage)

_Rationale:_ This allows `ralphctl sprint show` to inspect any sprint, while `sprint start` runs the current sprint (
which must be active).

## Feature Requirements

### Configuration Management

| Feature  | Requirement                         | Rationale                                    |
| -------- | ----------------------------------- | -------------------------------------------- |
| Show     | Display current configuration       | Users need visibility into settings          |
| Set      | Update configuration values         | Allow provider selection and future settings |
| Provider | Choose between Claude and Copilot   | User preference for AI backend               |
| Prompt   | Auto-prompt on first AI command use | Zero-config first experience                 |

**Provider Configuration:**

- Stored globally in `config.json` as `aiProvider` field
- Valid values: `"claude"` or `"copilot"`
- Not sprint-specific — one provider per development environment
- Prompts user to choose if not set when running AI commands

### Project Management

| Feature | Requirement                                     | Rationale                       |
| ------- | ----------------------------------------------- | ------------------------------- |
| Add     | Create project with name, display, repositories | Define multi-repo project       |
| List    | Show all projects                               | Overview of registered projects |
| Show    | Display project details, repos, scripts         | Inspection                      |
| Remove  | Delete project with confirmation                | Clean up unused projects        |

### Sprint Management

| Feature | Requirement                                            | Rationale                                     |
| ------- | ------------------------------------------------------ | --------------------------------------------- |
| Create  | Generate unique ID, initialize storage, set as current | Sprints need identity and immediate usability |
| List    | Show all sprints with status indicators                | Users need overview of all work               |
| Show    | Display sprint details, tickets, task summary          | Inspection without execution                  |
| Start   | Auto-activate draft, begin execution                   | Start execution phase (no separate activate)  |
| Close   | Transition active→closed, verify completion            | Clean end to work                             |
| Switch  | Change current sprint target                           | Multi-sprint workflow support                 |
| Refine  | Per-ticket requirements clarification                  | WHAT — implementation-agnostic                |
| Plan    | Generate tasks from approved requirements              | HOW — explore repos, create tasks             |
| Ideate  | Quick single-session refine + plan                     | Fast path for small ideas                     |
| Health  | Diagnose blockers, stale tasks, missing deps           | Sprint health monitoring                      |

### Ticket Management

| Feature     | Requirement                            | Rationale                         |
| ----------- | -------------------------------------- | --------------------------------- |
| Add         | Capture work request with project name | Link work to target project       |
| List        | Show tickets grouped by project        | Multi-project visibility          |
| Remove      | Delete ticket with confirmation        | Undo mistakes                     |
| External ID | Support optional issue tracker ID      | Enterprise workflow compatibility |
| Internal ID | Auto-generate stable ID                | Reliable referencing              |

### Task Management

| Feature | Requirement                            | Rationale                        |
| ------- | -------------------------------------- | -------------------------------- |
| Add     | Create task with steps, link to ticket | Manual task creation when needed |
| Import  | Bulk import with dependency validation | Support planning tools output    |
| List    | Show tasks in execution order          | Understand work sequence         |
| Status  | Update task status                     | Manual progress tracking         |
| Next    | Get next executable task               | Dependency-aware task selection  |
| Reorder | Change task priority                   | Adjust plans mid-execution       |
| Remove  | Delete task with confirmation          | Remove obsolete work             |

### Execution

| Feature               | Requirement                                | Rationale                             |
| --------------------- | ------------------------------------------ | ------------------------------------- |
| Headless mode         | Silent execution with spinner              | Automation, CI/CD                     |
| Watch mode            | Stream Claude output                       | Observe progress                      |
| Session mode          | Interactive collaboration                  | Complex tasks needing guidance        |
| Interactive mode      | Pause between tasks                        | Review before continuing              |
| Parallel execution    | Run independent tasks concurrently         | One task per unique projectPath       |
| Rate limit handling   | Pause new launches, resume on recovery     | Graceful degradation under API limits |
| Session resume        | Resume Claude sessions after rate limits   | Preserve full context on retry        |
| Resumability          | Continue from in_progress task             | Handle interruptions                  |
| Auto-commit           | Commit after each task                     | Atomic changes with history           |
| No-commit option      | Skip commits                               | When manual review needed             |
| Structured exit codes | Distinct codes for success, error, blocked | Scripting and CI/CD integration       |

### Exit Codes

| Code | Constant           | Meaning                               |
| ---- | ------------------ | ------------------------------------- |
| 0    | `EXIT_SUCCESS`     | All operations completed successfully |
| 1    | `EXIT_ERROR`       | Validation failed or execution error  |
| 2    | `EXIT_NO_TASKS`    | No tasks available to execute         |
| 3    | `EXIT_ALL_BLOCKED` | All remaining tasks blocked by deps   |
| 130  | `EXIT_INTERRUPTED` | SIGINT received (Unix: 128 + 2)       |

### Progress Tracking

| Feature          | Requirement                           | Rationale                |
| ---------------- | ------------------------------------- | ------------------------ |
| Log              | Append timestamped entries            | Audit trail              |
| Show             | Display progress history              | Review what happened     |
| Per-task logging | Structured progress in task execution | Context for future tasks |

## Acceptance Criteria

### Project Lifecycle

- [ ] Projects have unique slug names
- [ ] Projects require at least one repository
- [ ] Repository paths are validated as existing directories
- [ ] Projects can be removed only if not referenced by tickets

### Sprint Lifecycle

- [ ] New sprint starts as `draft`
- [ ] Only `draft` sprints can have tickets/tasks added
- [ ] `sprint start` auto-activates draft sprints
- [ ] Multiple sprints can be `active` at a time (parallel usage)
- [ ] Only `active` sprints can have task status updated
- [ ] `closed` sprints cannot be modified
- [ ] Sprint closure warns if tasks incomplete

### Ticket Flow

- [ ] Tickets require `projectName` referencing existing project
- [ ] Tickets get auto-generated internal `id`
- [ ] `requirementStatus` starts as `pending`
- [ ] `sprint refine` clarifies requirements (no code exploration)
- [ ] `sprint refine` sets `requirementStatus` to `approved`
- [ ] `sprint plan` proposes affected repos based on requirements
- [ ] `sprint plan` requires all tickets `approved`
- [ ] Repository selection saved to `ticket.affectedRepositories` during planning
- [ ] `sprint ideate` creates ticket and generates tasks in one session

### Task Execution

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

### Multi-Project Support

- [ ] Projects can have multiple repositories
- [ ] Tickets reference projects by name
- [ ] Tasks get projectPath from ticket's project
- [ ] Each task executes in its assigned project path

## Non-Requirements (Out of Scope)

These are explicitly NOT goals of ralphctl:

1. **Real-time collaboration** — Single-user CLI tool, not a team platform
2. **Issue tracker replacement** — Integrates with trackers, doesn't replace them
3. **Code review** — Focuses on implementation, not review workflow
4. **Deployment** — Stops at implementation and commit
5. **Testing execution** — Tasks include test steps, but ralphctl doesn't run tests directly
6. **Project scaffolding** — Works with existing projects, doesn't create them

## Agent Harness Patterns

ralphctl implements patterns
from [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
Key rationales:

### Why Verification-Gated Completion?

**Problem:** Agents often declare victory too early:

- Tests might be skipped or incomplete
- Lint errors ignored
- Build failures unnoticed

**Solution:** Require `<task-verified>` before `<task-complete>`. The agent must run verification and prove it passed.

### Why Pre-Existing Verification?

**Problem:** When taking over from a previous session or developer:

- State might already be broken
- Agent gets blamed for pre-existing issues
- Time wasted debugging inherited problems

**Solution:** Run verification BEFORE making changes. If it fails, output
`<task-blocked>Pre-existing failure: [details]</task-blocked>`.

### Why Git History in Context?

**Problem:** Agents lack awareness of recent changes:

- May duplicate work just done
- Miss patterns established by previous tasks
- Unaware of recent refactoring

**Solution:** Include last 20 commits in task context. Agent can see what was recently modified.

### Why Baseline Git State on Activation?

**Problem:** After a sprint, it's unclear what changed:

- Which commits were made during the sprint?
- What was the starting point?
- How to review sprint changes?

**Solution:** Log git state at sprint activation. Enables `git log baseline..HEAD` style reviews.

### Why Task Immutability?

**Problem:** Agents might modify task definitions:

- Removing inconvenient requirements
- Changing scope mid-execution
- Editing steps to match what they did (not what was planned)

**Solution:** Tasks are JSON (less likely to be edited by model). Agents can only signal status changes, not modify task
content.

## Future Considerations

Areas identified for potential expansion (not current requirements):

1. **Sprint templates** — Reusable sprint structures for common patterns
2. **Progress analytics** — Track velocity, completion rates, time estimates
3. **Webhook notifications** — Notify external systems on task completion
4. **Rollback support** — Revert task implementations if issues found
5. **Setup script execution** — Run `repository.setupScript` before sprint start (see ARCHITECTURE.md TODO)
