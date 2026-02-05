# RalphCTL - Architecture

Technical documentation of the internal architecture, data models, services, and implementation details.

> **See also:** [REQUIREMENTS.md](./REQUIREMENTS.md) for functional requirements and design rationale.

## Architecture Overview

4-layer architecture: Interactive → Commands → Store → Claude

```
ralphctl/
├── src/
│   ├── cli.ts              # Entry point (commander.js program)
│   ├── commands/            # Layer 2: CLI command implementations
│   │   ├── project/         # Project subcommands
│   │   ├── sprint/          # Sprint subcommands
│   │   ├── task/            # Task subcommands
│   │   ├── ticket/          # Ticket subcommands
│   │   └── progress/        # Progress subcommands
│   ├── interactive/         # Layer 1: Interactive REPL mode
│   │   ├── index.ts         # REPL loop & command dispatch
│   │   ├── menu.ts          # Menu definitions
│   │   └── selectors.ts     # Shared interactive selectors
│   ├── store/               # Layer 3: Data persistence
│   │   ├── config.ts        # Configuration management
│   │   ├── project.ts       # Project CRUD + validation
│   │   ├── sprint.ts        # Sprint CRUD + state machine
│   │   ├── task.ts          # Task CRUD + dependencies
│   │   ├── ticket.ts        # Ticket CRUD
│   │   └── progress.ts      # Progress log read/append
│   ├── claude/              # Layer 4: Claude integration
│   │   ├── runner.ts        # Task execution orchestrator
│   │   ├── session.ts       # Claude CLI spawning (sync/async)
│   │   ├── parser.ts        # Output signal parsing
│   │   └── prompts/         # Prompt templates
│   │       ├── index.ts     # Prompt builders
│   │       ├── plan-auto.md
│   │       ├── plan-interactive.md
│   │       ├── ticket-refine.md
│   │       └── task-execution.md
│   ├── theme/               # Ralph Wiggum theme
│   │   ├── index.ts         # Colors, quotes, emoji, banner constants
│   │   └── ui.ts            # UI components (icons, showSuccess, field, etc.)
│   ├── schemas/             # Zod validation schemas
│   │   └── index.ts         # All type definitions
│   └── utils/               # Pure utilities
│       ├── ids.ts           # ID generation
│       ├── paths.ts         # Path resolution
│       └── storage.ts       # File I/O with validation
├── schemas/                 # JSON schemas for external tools
└── ralphctl-data/           # Data storage (git-ignored)
    ├── config.json          # Global config
    ├── projects.json        # Project definitions
    └── sprints/             # Per-sprint directories
```

## CLI Framework

ralphctl uses [commander.js](https://github.com/tj/commander.js/) for CLI argument parsing.

**Entry point** (`cli.ts`):

- Registers command groups via `registerXCommands(program)` functions
- No args or `interactive` → enters interactive REPL mode
- Otherwise → commander parses argv

**Command registration** (each `commands/*/index.ts`):

```typescript
export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Manage projects');
  project.command('add').option('--name <name>').action(projectAddCommand);
  // ...
}
```

**Interactive mode** (`interactive/index.ts`):

- Menu-driven REPL with donut-themed selector
- Dispatches directly to command functions via a command map
- Uses shared selectors from `interactive/selectors.ts`

## Data Models

### Project

Named entity representing one or more related repositories.

```typescript
interface Project {
  name: string; // Slug (e.g., "my-app") - also serves as ID
  displayName: string; // Human-readable name
  repositories: Repository[]; // Array of repositories (at least one)
  description?: string; // Optional description
}

interface Repository {
  name: string; // Auto-derived from basename(path)
  path: string; // Absolute path
  setupScript?: string; // e.g., "npm install"
  verifyScript?: string; // e.g., "npm test"
}
```

**Constraints:**

- `name` must be lowercase alphanumeric with hyphens (slug format)
- At least one repository required
- Repository paths validated as existing directories

**Verification Script Resolution:**

1. Explicit `verifyScript` from project (highest priority)
2. Auto-detected from project files (package.json, pyproject.toml, etc.)
3. CLAUDE.md discovery (fallback)

### Sprint

Container for a planning session. Manages lifecycle from draft to execution to closure.

```typescript
interface Sprint {
  id: string; // Format: YYYYMMDD-HHmmss-<slug>
  name: string; // Human-readable name
  status: 'draft' | 'active' | 'closed';
  createdAt: string; // ISO8601 datetime
  activatedAt: string | null; // When activated
  closedAt: string | null; // When closed
  tickets: Ticket[]; // Array of tickets
}
```

**Status transitions** (one-way only):

- `draft` → `active`: Auto-activated by `sprint start`
- `active` → `closed`: Via `sprint close`

**Constraints:**

- `closed` sprints are immutable
- Multiple sprints can be `active` simultaneously (parallel terminal usage)
- Planning operations (add tickets, refine, plan) require `draft` status
- Execution operations (start, update task status) require `active` status

### Ticket

Unit of work representing a feature, bug, or epic. Links to external issue trackers.

```typescript
interface Ticket {
  id: string; // Internal UUID8 (auto-generated)
  externalId?: string; // Optional: JIRA-123, GH-456
  title: string; // Short summary (required)
  description?: string; // Detailed requirements
  link?: string; // URL to issue tracker
  projectName: string; // References Project.name
  requirementStatus: 'pending' | 'approved';
  requirements?: string; // Refined requirements (markdown)
  affectedRepositories?: string[]; // Repository paths selected during planning
}
```

**Key behaviors:**

- `projectName` references a project; tasks get paths from the project
- `requirements` populated during `sprint refine` phase (pure requirements gathering)
- `affectedRepositories` populated during `sprint plan` phase (implementation planning)
- `requirementStatus` must be `approved` before `sprint plan`

### Task

Atomic unit of implementation work.

```typescript
interface Task {
  id: string; // UUID8
  name: string; // Actionable description
  description?: string; // Details
  steps: string[]; // Implementation steps
  status: 'todo' | 'in_progress' | 'done';
  order: number; // Execution priority (1-indexed)
  ticketId?: string; // Parent ticket reference
  blockedBy: string[]; // Dependency task IDs
  projectPath: string; // Execution path (from project)
  verified: boolean; // Whether verification passed (default: false)
  verificationOutput?: string; // Output from verification run
}
```

**Status flow:**

- `todo` → `in_progress`: Task picked up by runner
- `in_progress` → `done`: Completion signal received
- `in_progress` is resumable (task continues on next `sprint start`)

**Verification tracking:**

- `verified` set to `true` when `<task-verified>` signal received
- `verificationOutput` stores the verification command output
- Completion requires verification (headless mode)

**Dependencies:**

- Validated on import (no cycles, no missing refs, no forward refs)
- Tasks reordered by topological sort before execution

### Config

Global application state.

```typescript
interface Config {
  currentSprint: string | null; // Which sprint CLI commands target
}
```

Note: The "active" status is part of the sprint's lifecycle (stored in `sprint.json`), not a separate config field. Multiple sprints can be active simultaneously.

## ID Generation

Located in `utils/ids.ts`:

```typescript
generateUuid8(): string           // 8-char hex (for tickets, tasks)
generateSprintId(): string        // YYYY-MM-DD-<seq>-<uuid8>
```

**Sprint ID format:** `20260204-154532-api-refactor`

- Date-time prefix for lexicographic sorting
- Human-readable slug (from name) or uuid8 (if no name)

## Store Layer

### Config Store (`store/config.ts`)

```typescript
getConfig(): Config
saveConfig(config: Config): void
getCurrentSprint(): string | null
setCurrentSprint(id: string | null): void
```

### Project Store (`store/project.ts`)

```typescript
listProjects(): Project[]
getProject(name: string): Project
projectExists(name: string): boolean
createProject(project: Project): Project
updateProject(name: string, updates: Partial<Project>): Project
removeProject(name: string): void
getProjectPaths(name: string): string[]
addProjectPath(name: string, path: string): Project
removeProjectPath(name: string, path: string): Project
```

**Error classes:**

- `ProjectNotFoundError`: Project name doesn't exist
- `ProjectExistsError`: Project name already exists

### Sprint Store (`store/sprint.ts`)

```typescript
createSprint(name: string): Sprint
getSprint(sprintId: string): Sprint
saveSprint(sprint: Sprint): void
listSprints(): Sprint[]
activateSprint(sprintId: string): Sprint
closeSprint(sprintId: string): Sprint
getCurrentSprintOrThrow(): Sprint
getActiveSprintOrThrow(): Sprint
resolveSprintId(sprintId?: string): string
assertSprintStatus(sprint: Sprint, allowed: SprintStatus[], operation: string): void
```

**Error classes:**

- `SprintNotFoundError`: Sprint ID doesn't exist
- `SprintStatusError`: Invalid status for operation (includes hint)

### Task Store (`store/task.ts`)

```typescript
getTasks(sprintId?: string): Task[]
saveTasks(tasks: Task[], sprintId?: string): void
getTask(taskId: string, sprintId?: string): Task
addTask(input: TaskInput, sprintId?: string): Task
removeTask(taskId: string, sprintId?: string): void
updateTaskStatus(taskId: string, status: TaskStatus, sprintId?: string): Task
getNextTask(sprintId?: string): Task | null
listTasks(sprintId?: string): Task[]
reorderTask(taskId: string, newOrder: number, sprintId?: string): void
topologicalSort(tasks: Task[]): Task[]
reorderByDependencies(sprintId?: string): void
validateImportTasks(importTasks: ImportTask[], existingTasks: Task[]): string[]
areAllTasksDone(sprintId?: string): boolean
```

**Error classes:**

- `TaskNotFoundError`: Task ID doesn't exist
- `TaskStatusError`: Invalid status operation
- `DependencyCycleError`: Cycle detected in dependencies

### Ticket Store (`store/ticket.ts`)

```typescript
addTicket(input: TicketInput, sprintId?: string): Ticket
removeTicket(ticketId: string, sprintId?: string): void
listTickets(sprintId?: string): Ticket[]
getTicket(ticketId: string, sprintId?: string): Ticket
getTicketByTitle(title: string, sprintId?: string): Ticket | undefined
groupTicketsByProject(tickets: Ticket[]): Map<string, Ticket[]>
allRequirementsApproved(tickets: Ticket[]): boolean
getPendingRequirements(tickets: Ticket[]): Ticket[]
formatTicketDisplay(ticket: Ticket): string
formatTicketId(ticket: Ticket): string
```

**Error classes:**

- `TicketNotFoundError`: Ticket doesn't exist
- `DuplicateTicketError`: External ID already exists

### Progress Store (`store/progress.ts`)

```typescript
logProgress(message: string, sprintId?: string): void
getProgress(sprintId?: string): string
```

## Claude Integration Layer

### Session (`claude/session.ts`)

Handles Claude CLI process spawning:

```typescript
spawnClaudeInteractive(prompt: string, options: SpawnSyncOptions): { code: number; error?: string }
spawnClaudeHeadless(options: SpawnAsyncOptions): Promise<string>
```

**Interactive/Session mode** uses `spawnSync` with inherited stdio.
**Headless mode** uses `spawn` with piped stdio (stdin closed immediately to prevent hanging).

### Parser (`claude/parser.ts`)

Parses task execution output for completion signals:

```typescript
interface ExecutionResult {
  success: boolean;
  output: string;
  blockedReason?: string;
  verified?: boolean;
  verificationOutput?: string;
}

parseExecutionResult(output: string): ExecutionResult
```

### Runner (`claude/runner.ts`)

Main execution orchestrator for `sprint start`. Implements patterns from [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

```typescript
runSprint(sprintId?: string, options: RunOptions): Promise<void>

interface RunOptions {
  watch?: boolean;       // Stream Claude output
  session?: boolean;     // Interactive session
  interactive?: boolean; // Pause between tasks
  count?: number;        // Limit task count
  noCommit?: boolean;    // Skip auto-commit
}
```

**Execution flow:**

1. Validate sprint is `active`
2. Reorder tasks by dependencies
3. Loop: `getNextTask()` → execute → update status
4. Store verification results
5. Log progress

**Task Context:**

Each task receives context including:

- Task specification (name, description, steps)
- Git history (last 20 commits)
- Verification command (explicit, auto-detected, or CLAUDE.md reference)
- Progress history (filtered by project)

```typescript
getRecentGitHistory(projectPath: string, count?: number): string
detectVerifyScript(projectPath: string): string | null
getEffectiveVerifyScript(project: Project | undefined, projectPath: string): string | null
```

**Completion signals:**

- `<task-verified>output</task-verified>` - Verification passed (required before completion in headless mode)
- `<task-complete>` - Task finished successfully
- `<task-blocked>reason</task-blocked>` - Task cannot proceed

### Prompt Templates (`claude/prompts/`)

| Template              | Purpose                                             | Variables                                      | Mode        |
| --------------------- | --------------------------------------------------- | ---------------------------------------------- | ----------- |
| `ticket-refine.md`    | Requirements refinement (WHAT, no code exploration) | `{{TICKET}}`, `{{OUTPUT_FILE}}`                | Interactive |
| `plan-interactive.md` | Plan tasks with repo selection & iteration          | `{{CONTEXT}}`, `{{OUTPUT_FILE}}`, `{{SCHEMA}}` | Interactive |
| `plan-auto.md`        | Headless task generation with repo selection        | `{{CONTEXT}}`, `{{SCHEMA}}`                    | Auto        |
| `task-execution.md`   | Implement a task                                    | `{{PROGRESS_FILE}}`, `{{COMMIT_INSTRUCTION}}`  | All modes   |

### Prompt Builders

```typescript
buildTicketRefinePrompt(ticketContent: string, outputFile: string): string
buildInteractivePrompt(context: string, outputFile: string, schema: string): string
buildAutoPrompt(context: string, schema: string): string
buildTaskExecutionPrompt(progressFilePath: string, noCommit: boolean): string
```

## Interactive Mode

### Shared Selectors (`interactive/selectors.ts`)

Reusable entity selectors with donut-themed prompts:

```typescript
selectProject(message?): string | null      // Select project by name
selectSprint(message?, filter?): string | null  // Select sprint by ID, optional status filter
selectTicket(message?): string | null       // Select ticket by ID
selectTask(message?, filter?): string | null    // Select task by ID, optional status filter
selectTaskStatus(message?): TaskStatus      // Select a task status
inputPositiveInt(message): number           // Prompt for a positive integer
```

All selectors return `null` when no entities are available (with a muted message).
Used by command files for interactive fallback when args are missing.

## File Storage

### Directory Structure

```
ralphctl-data/                    # Git-ignored
├── config.json                   # Global config
├── projects.json                 # Project definitions
└── sprints/
    └── <sprint-id>/              # e.g., 20260204-154532-api-refactor/
        ├── sprint.json           # Sprint + tickets
        ├── tasks.json            # Task array
        ├── progress.md           # Append-only log
        ├── refinement/           # Created by `sprint refine`
        │   └── <ticket-id>/
        │       ├── refine-context.md    # Prompt/context sent to Claude
        │       └── requirements.json    # Claude's refined requirements
        └── planning/             # Created by `sprint plan`
            ├── planning-context.md  # Prompt/context sent to Claude
            └── tasks.json           # Claude's generated tasks (before import)
```

### Storage Utilities (`utils/storage.ts`)

All data read/write uses Zod validation:

```typescript
readValidatedJson<T>(filePath: string, schema: ZodSchema<T>): T
writeValidatedJson<T>(filePath: string, data: T, schema: ZodSchema<T>): void
fileExists(filePath: string): boolean
listDirs(dirPath: string): string[]
appendToFile(filePath: string, content: string): void
readTextFile(filePath: string): string
```

**Error classes:**

- `ValidationError`: Zod validation failed
- `FileNotFoundError`: File doesn't exist

### Path Resolution (`utils/paths.ts`)

```typescript
getRalphctlRoot(): string                  // Env override or default
getDataDir(): string                       // ralphctl-data/
getProjectsFilePath(): string              // ralphctl-data/projects.json
getSprintsDir(): string                    // ralphctl-data/sprints
getSprintDir(sprintId): string             // ralphctl-data/sprints/<id>
getSprintFilePath(sprintId): string        // .../sprint.json
getTasksFilePath(sprintId): string         // .../tasks.json
getProgressFilePath(sprintId): string      // .../progress.md
getConfigPath(): string                    // ralphctl-data/config.json
validateProjectPath(path: string): boolean
```

## Dependency Resolution

### Topological Sort Algorithm

Located in `store/task.ts`:

1. Build adjacency list from `blockedBy` relationships
2. Depth-first traversal with cycle detection
3. Uses `visiting` set to detect back-edges (cycles)
4. Uses `visited` set to avoid re-processing
5. Returns tasks in dependency order

### Import Validation

Before importing tasks, validates:

1. All `blockedBy` references exist (local or real IDs)
2. Local IDs reference earlier tasks only (no forward references)
3. No cycles in combined graph (import + existing tasks)

Two-pass import:

1. Create all tasks, build local→real ID mapping
2. Update `blockedBy` with resolved real IDs

## Two-Phase Planning

### Phase 1: Requirements Refinement (`sprint refine`)

Focus: Clarify WHAT needs to be done (implementation-agnostic)

1. Load pending tickets (`requirementStatus: 'pending'`)
2. For each ticket:
   - Display ticket details
   - Spawn interactive Claude session
   - Claude asks clarifying questions about requirements and acceptance criteria
   - **NO code exploration** - pure requirements gathering
   - User answers via selection UI
   - Claude writes refined requirements to temp JSON file
3. Parse requirements, match to tickets by ID or title
4. Update `ticket.requirements` and set `requirementStatus: 'approved'`

### Phase 2: Task Generation (`sprint plan`)

Focus: Determine HOW it will be implemented

1. Verify all tickets are `approved`
2. For each ticket:
   - Claude analyzes approved requirements
   - Claude proposes which repositories are affected
   - User confirms repository selection (checkbox UI)
   - Selection saved to `ticket.affectedRepositories`
   - Claude explores ONLY the confirmed repos
   - Claude generates tasks with dependencies
3. Build context with refined requirements and codebase analysis
4. Interactive: User iterates with Claude
5. Auto: Claude generates tasks headlessly
6. Parse JSON output
7. Validate dependencies
8. Import tasks (two-pass for ID resolution)

## Error Handling

### Custom Error Classes

| Class                  | Module  | Cause                        |
| ---------------------- | ------- | ---------------------------- |
| `ValidationError`      | storage | Zod validation failed        |
| `FileNotFoundError`    | storage | File missing                 |
| `ProjectNotFoundError` | project | Invalid project name         |
| `ProjectExistsError`   | project | Project name already exists  |
| `SprintNotFoundError`  | sprint  | Invalid sprint ID            |
| `SprintStatusError`    | sprint  | Invalid status for operation |
| `TicketNotFoundError`  | ticket  | Invalid ticket ID            |
| `DuplicateTicketError` | ticket  | External ID already exists   |
| `TaskNotFoundError`    | task    | Invalid task ID              |
| `TaskStatusError`      | task    | Invalid status operation     |
| `DependencyCycleError` | task    | Cycle in dependencies        |

### CLI Error Handling

- Commands validate input before calling store functions
- Store errors bubble up with descriptive messages
- Sprint state errors include hints for resolution
- `process.exit(1)` for fatal errors

## Testing

Test files in `src/**/*.test.ts`:

- `schemas/index.test.ts` - Schema validation (Project, Sprint, Ticket, Task, Config)
- `store/task.test.ts` - Task store (ordering, dependencies, cycles)
- `store/ticket.test.ts` - Ticket store (grouping, filtering)
- `store/progress.test.ts` - Progress store
- `claude/runner.test.ts` - Runner and parser tests
- `integration/cli.test.ts` - Store integration tests
- `integration/cli-smoke.test.ts` - CLI subprocess tests

Run with:

```bash
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
pnpm test:coverage  # Coverage report
```

## Technology Stack

- **Runtime:** Node.js 24+
- **Language:** TypeScript (ES2024, strict mode)
- **Package Manager:** pnpm
- **CLI Framework:** commander.js
- **Validation:** Zod
- **CLI Prompts:** @inquirer/prompts
- **Terminal Styling:** colorette
- **ID Generation:** crypto (randomBytes)
- **Testing:** Vitest
- **Linting:** ESLint + Prettier

## TODO / Future Considerations

### Run setupScript on sprint start

Currently `setupScript` is stored on Repository but never executed. Per the [Anthropic article](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), an `init.sh` script should run before agents start to ensure the environment is ready.

**Potential implementation:**

```
sprint start (during activation):
  for each unique projectPath in tasks:
    if repository.setupScript:
      run setupScript in projectPath
      if fails: abort activation with error
  proceed to activate and start sprint
```

**Considerations:**

- Add `--skip-setup` flag for cases where setup is already done
- Could be slow for projects with heavy setup (npm install)
- May need timeout handling
- Should log output for debugging if setup fails
