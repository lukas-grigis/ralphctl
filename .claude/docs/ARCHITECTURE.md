# RalphCTL - Architecture

Technical documentation of the internal architecture, data models, services, and implementation details.

> **See also:** [REQUIREMENTS.md](./REQUIREMENTS.md) for functional requirements and design rationale.

## Architecture Overview

4-layer architecture: Interactive → Commands → Store → AI Provider

```
ralphctl/
├── src/
│   ├── cli.ts              # Entry point (commander.js program)
│   ├── commands/            # Layer 2: CLI command implementations
│   │   ├── config/          # Configuration commands
│   │   │   ├── config.ts    # Set/show configuration
│   │   │   └── index.ts     # Command registration
│   │   ├── project/         # Project subcommands
│   │   ├── sprint/          # Sprint subcommands
│   │   │   ├── health.ts    # Sprint health checks
│   │   │   ├── requirements.ts  # Requirements export
│   │   │   ├── switch.ts    # Switch current sprint
│   │   │   └── ...
│   │   ├── task/            # Task subcommands
│   │   ├── ticket/          # Ticket subcommands
│   │   └── progress/        # Progress subcommands
│   ├── interactive/         # Layer 1: Interactive REPL mode
│   │   ├── index.ts         # REPL loop & command dispatch
│   │   ├── menu.ts          # Menu definitions
│   │   ├── selectors.ts     # Shared interactive selectors
│   │   ├── wizard.ts        # Quick Start wizard
│   │   ├── dashboard.ts     # Dashboard data & actions
│   │   └── file-browser.ts  # File browser for path selection
│   ├── store/               # Layer 3: Data persistence
│   │   ├── config.ts        # Configuration management
│   │   ├── project.ts       # Project CRUD + validation
│   │   ├── sprint.ts        # Sprint CRUD + state machine
│   │   ├── task.ts          # Task CRUD + dependencies
│   │   ├── ticket.ts        # Ticket CRUD
│   │   └── progress.ts      # Progress log read/append
│   ├── providers/           # Layer 4: AI provider abstraction
│   │   ├── index.ts         # Provider factory & resolution
│   │   ├── types.ts         # ProviderAdapter interface
│   │   ├── claude.ts        # Claude Code adapter
│   │   └── copilot.ts       # GitHub Copilot adapter
│   ├── claude/              # Layer 4: AI integration (provider-agnostic)
│   │   ├── runner.ts        # Sprint execution harness (delegates to executor)
│   │   ├── session.ts       # AI CLI spawning (sync/async) + retry
│   │   ├── parser.ts        # Output signal parsing
│   │   ├── executor.ts      # Sequential & parallel task execution
│   │   ├── rate-limiter.ts  # Rate limit coordination
│   │   ├── permissions.ts   # AI permission checking
│   │   ├── process-manager.ts  # Graceful shutdown / signal handling
│   │   ├── task-context.ts  # Context building for task execution
│   │   └── prompts/         # Prompt templates (shared across providers)
│   │       ├── index.ts     # Prompt builders
│   │       ├── plan-auto.md
│   │       ├── plan-interactive.md
│   │       ├── plan-common.md   # Shared planning context
│   │       ├── ticket-refine.md
│   │       ├── task-execution.md
│   │       ├── ideate.md        # Interactive ideation
│   │       └── ideate-auto.md   # Headless ideation
│   ├── theme/               # Ralph Wiggum theme
│   │   ├── index.ts         # Colors, quotes, emoji, banner constants
│   │   └── ui.ts            # UI components (icons, showSuccess, field, etc.)
│   ├── schemas/             # Zod validation schemas
│   │   └── index.ts         # All type definitions
│   └── utils/               # Pure utilities
│       ├── ids.ts           # ID generation
│       ├── paths.ts         # Path resolution
│       ├── provider.ts      # Provider resolution & display helpers
│       ├── storage.ts       # File I/O with validation
│       ├── json-extract.ts  # JSON array extraction from mixed output
│       ├── requirements-export.ts  # Requirements markdown formatter
│       ├── detect-scripts.ts # Heuristic project-type detection & script suggestions
│       ├── exit-codes.ts    # Structured exit codes
│       ├── file-lock.ts     # File-based locking
│       ├── multiline.ts     # Multiline text utility
│       └── path-selector.ts # Interactive path selection UI
├── schemas/                 # JSON schemas for external tools
└── ~/.ralphctl/             # Data storage (default)
    ├── config.json          # Global config (includes aiProvider)
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

## Provider Abstraction Layer

RalphCTL supports multiple AI providers through a unified `ProviderAdapter` interface (`src/providers/types.ts`).

### ProviderAdapter Interface

```typescript
interface ProviderAdapter {
  readonly name: AiProvider; // "claude" | "copilot"
  readonly displayName: string; // "Claude Code" | "GitHub Copilot"
  readonly binary: string; // "claude" | "copilot"
  readonly baseArgs: string[]; // Base CLI flags (permissions, tools)

  buildInteractiveArgs(prompt: string, extraArgs?: string[]): string[];
  buildHeadlessArgs(extraArgs?: string[]): string[];
  parseJsonOutput(stdout: string): { result: string; sessionId: string | null };
  detectRateLimit(stderr: string): RateLimitInfo;
  getSpawnEnv(): Record<string, string>;
}
```

### Supported Providers

**Claude Code Adapter** (`src/providers/claude.ts`):

- Binary: `claude`
- Permission flag: `--permission-mode acceptEdits` (respects `.claude/settings*.json` allow/deny)
- Output format: `--output-format json`
- Session management: Built-in session IDs
- Rate limit detection: Parses stderr for rate limit messages
- Env vars: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`

**GitHub Copilot Adapter** (`src/providers/copilot.ts`):

- Binary: `copilot`
- Permission flag: `--allow-all-tools` (bypasses per-tool approval entirely — no settings files)
- Output format: plain text (`-p -s`); no JSON mode, no session ID
- Session management: Session ID unavailable from headless output
- Rate limit detection: Parses stderr for rate limit messages
- Env vars: None

### Provider Resolution

**Automatic resolution** (`src/utils/provider.ts`):

1. Read `aiProvider` from `config.json`
2. If not set, prompt user with interactive select:
   ```
   🍩 Which AI buddy should help with my homework?
   › Claude Code
     GitHub Copilot
   ```
3. Save selection to `config.json` for future commands
4. Return provider adapter

**Manual configuration:**

```bash
ralphctl config set provider claude
ralphctl config set provider copilot
```

### Shared Infrastructure

**Prompt Templates** (`src/ai/prompts/`):

- All `.md` prompt files are provider-agnostic
- Variable substitution via `{{PLACEHOLDER}}` syntax
- Used by both Claude Code and GitHub Copilot

**Session Management** (`src/ai/session.ts`):

- Provider-agnostic spawn functions (sync, async, interactive, headless)
- Delegates CLI-specific details to provider adapter
- Rate limit detection and retry logic

**Execution Layer** (`src/ai/executor.ts`):

- No provider-specific code
- Uses adapter for spawning AI CLI
- Shared task execution flow for both providers

### Adding New Providers

To add a new provider (e.g., Gemini, GPT):

1. Create `src/providers/<name>.ts` implementing `ProviderAdapter`
2. Add to `AiProviderSchema` enum in `src/schemas/index.ts`
3. Add case to `getProvider()` in `src/providers/index.ts`
4. Add choice to prompt in `src/utils/provider.ts`

No changes needed in command logic or prompt templates.

## Data Models

> **Note:** All store APIs are `async` (return Promises). The signatures below reflect this.

### Project

Named entity representing one or more related repositories.

```typescript
interface Project {
  name: string; // Slug (e.g., "my-app") — also serves as ID
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

1. Explicit `verifyScript` from repository config (only source at runtime)
2. CLAUDE.md discovery (fallback when no script configured — agent reads project root)

Heuristic detection (`src/utils/detect-scripts.ts`) is used only as editable suggestions during `project add`.

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
  setupRanAt: Record<string, string>; // projectPath → ISO8601 timestamp (default: {})
}
```

**Status transitions** (one-way only):

- `draft` → `active`: Auto-activated by `sprint start`
- `active` → `closed`: Via `sprint close`

**Constraints:**

- `closed` sprints are immutable
- Multiple sprints can be `active` simultaneously (parallel terminal usage)
- Planning operations (add tickets, refine, ideate, plan) require `draft` status
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

### RefinedRequirement

Output format from `sprint refine` command. Array of these written to temporary JSON file.

```typescript
interface RefinedRequirement {
  ref: string; // Ticket reference (ID, externalId, or title)
  requirements: string; // Refined requirements in markdown format
}

type RefinedRequirements = RefinedRequirement[];
```

**Key behaviors:**

- `ref` can be internal ID, external ID, or exact title — used to match back to tickets
- `requirements` contains markdown-formatted refined requirements (problem, acceptance criteria, scope, constraints)
- Validated against `RefinedRequirementsSchema` before processing

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
  aiProvider: AiProvider | null; // User's preferred AI provider ("claude" | "copilot")
}
```

**Fields:**

- `currentSprint`: Convenience pointer for targeting commands (e.g., `task add`, `sprint show`)
- `aiProvider`: Global provider selection; prompts user on first AI command if null

Note: The "active" status is part of the sprint's lifecycle (stored in `sprint.json`), not a separate config field.
Multiple sprints can be active simultaneously.

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

All store functions are `async` and return Promises.

### Config Store (`store/config.ts`)

```typescript
async getConfig(): Promise<Config>
async saveConfig(config: Config): Promise<void>
async getCurrentSprint(): Promise<string | null>
async setCurrentSprint(id: string | null): Promise<void>
async getAiProvider(): Promise<AiProvider | null>
async setAiProvider(provider: AiProvider): Promise<void>
```

### Project Store (`store/project.ts`)

```typescript
async listProjects(): Promise<Projects>
async getProject(name: string): Promise<Project>
async projectExists(name: string): Promise<boolean>
async createProject(project: Project): Promise<Project>
async updateProject(name: string, updates: Partial<Omit<Project, 'name'>>): Promise<Project>
async removeProject(name: string): Promise<void>
async getProjectRepos(name: string): Promise<Repository[]>
async addProjectRepo(name: string, repo: Repository): Promise<Project>
async removeProjectRepo(name: string, path: string): Promise<Project>
```

**Error classes:**

- `ProjectNotFoundError`: Project name doesn't exist
- `ProjectExistsError`: Project name already exists

### Sprint Store (`store/sprint.ts`)

```typescript
assertSprintStatus(sprint: Sprint, allowedStatuses: SprintStatus[], operation: string): asserts sprint is Sprint
async createSprint(name?: string): Promise<Sprint>
async findActiveSprint(): Promise<Sprint | null>
async getSprint(sprintId: string): Promise<Sprint>
async saveSprint(sprint: Sprint): Promise<void>
async listSprints(): Promise<Sprint[]>
async activateSprint(sprintId: string): Promise<Sprint>
async closeSprint(sprintId: string): Promise<Sprint>
async deleteSprint(sprintId: string): Promise<Sprint>
async getCurrentSprintOrThrow(): Promise<Sprint>
async getActiveSprintOrThrow(): Promise<Sprint>
async resolveSprintId(sprintId?: string): Promise<string>
```

**Error classes:**

- `SprintNotFoundError`: Sprint ID doesn't exist
- `SprintStatusError`: Invalid status for operation (includes hint)
- `NoCurrentSprintError`: No current sprint set in config

### Task Store (`store/task.ts`)

```typescript
async getTasks(sprintId?: string): Promise<Tasks>
async saveTasks(tasks: Tasks, sprintId?: string): Promise<void>
async getTask(taskId: string, sprintId?: string): Promise<Task>
async addTask(input: AddTaskInput, sprintId?: string): Promise<Task>
async removeTask(taskId: string, sprintId?: string): Promise<void>
async updateTaskStatus(taskId: string, status: TaskStatus, sprintId?: string): Promise<Task>
async updateTask(taskId: string, updates: UpdateTaskInput, sprintId?: string): Promise<Task>
async isTaskBlocked(taskId: string, sprintId?: string): Promise<boolean>
async getNextTask(sprintId?: string): Promise<Task | null>
getReadyTasksFromList(tasks: Tasks): Tasks                    // pure function
async getReadyTasks(sprintId?: string): Promise<Tasks>
async reorderTask(taskId: string, newOrder: number, sprintId?: string): Promise<Task>
async listTasks(sprintId?: string): Promise<Tasks>
async getRemainingTasks(sprintId?: string): Promise<Tasks>
async areAllTasksDone(sprintId?: string): Promise<boolean>
topologicalSort(tasks: Tasks): Tasks                          // pure function
async reorderByDependencies(sprintId?: string): Promise<void>
validateImportTasks(importTasks: ImportTask[], existingTasks: Tasks, ticketIds?: Set<string>): string[]  // pure function
```

**Error classes:**

- `TaskNotFoundError`: Task ID doesn't exist
- `TaskStatusError`: Invalid status operation
- `DependencyCycleError`: Cycle detected in dependencies

### Ticket Store (`store/ticket.ts`)

```typescript
async addTicket(input: TicketInput, sprintId?: string): Promise<Ticket>
async removeTicket(ticketId: string, sprintId?: string): Promise<void>
async listTickets(sprintId?: string): Promise<Ticket[]>
async getTicket(ticketId: string, sprintId?: string): Promise<Ticket>
async getTicketByTitle(title: string, sprintId?: string): Promise<Ticket | undefined>
groupTicketsByProject(tickets: Ticket[]): Map<string, Ticket[]>       // pure function
allRequirementsApproved(tickets: Ticket[]): boolean                   // pure function
getPendingRequirements(tickets: Ticket[]): Ticket[]                   // pure function
formatTicketDisplay(ticket: Ticket): string                           // pure function
formatTicketId(ticket: Ticket): string                                // pure function
```

**Error classes:**

- `TicketNotFoundError`: Ticket doesn't exist
- `DuplicateTicketError`: External ID already exists

### Progress Store (`store/progress.ts`)

```typescript
async logProgress(message: string, sprintId?: string): Promise<void>
async getProgress(sprintId?: string): Promise<string>
```

## Claude Integration Layer

### Session (`claude/session.ts`)

Handles Claude CLI process spawning with retry and rate limit detection:

```typescript
// Interfaces
interface SpawnSyncOptions { cwd: string; args?: string[]; env?: Record<string, string> }
interface SpawnAsyncOptions { cwd: string; args?: string[]; env?: Record<string, string> }
interface HeadlessSpawnOptions extends SpawnAsyncOptions { prompt?: string; resumeSessionId?: string }
interface SpawnResult { stdout: string; stderr: string; exitCode: number; sessionId: string | null }
interface ClaudeJsonResult { type: string; subtype: string; is_error: boolean; result: string; session_id: string; duration_ms: number; total_cost_usd: number; num_turns: number }

// Error class
class SpawnError extends Error { stderr: string; exitCode: number; rateLimited: boolean; retryAfterMs: number | null; sessionId: string | null }

// Functions
spawnInteractive(prompt: string, options: SpawnSyncOptions): { code: number; error?: string }
async spawnHeadless(options: SpawnAsyncOptions & { prompt?: string }): Promise<string>
async spawnHeadlessRaw(options: HeadlessSpawnOptions): Promise<SpawnResult>
async spawnWithRetry(options: HeadlessSpawnOptions, retryOptions?: { maxRetries?, baseDelayMs?, maxDelayMs? }): Promise<SpawnResult>
detectRateLimit(stderr: string): { rateLimited: boolean; retryAfterMs: number | null }
parseJsonOutput(stdout: string): { result: string; sessionId: string | null }
```

**Interactive/Session mode** uses `spawnSync` with inherited stdio.
**Headless mode** uses `spawn` with piped stdio (stdin closed immediately to prevent hanging).
**Retry logic** (`spawnWithRetry`) uses exponential backoff + jitter; auto-resumes sessions via `--resume`.
**JSON output** (`--output-format json`) captures `session_id` for resumability.

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

### Task Context (`claude/task-context.ts`)

Builds context for task execution. Uses primacy/recency layout (important info at start and end of context).

```typescript
interface TaskContext { sprint: Sprint; task: Task; project?: Project }

// Setup status types — populated by runSetupScripts, consumed by buildFullTaskContext
type SetupStatus = { ran: true; script: string } | { ran: false; reason: 'no-script' }
type SetupResults = Map<string, SetupStatus>  // projectPath → SetupStatus

// Pre-flight verification result — populated by runPreFlightForTask, consumed by buildFullTaskContext
type PreFlightResult =
  | { status: 'passed'; script: string }
  | { status: 'failed-resuming'; script: string; output: string }
  | null

getRecentGitHistory(projectPath: string, count?: number): string
getEffectiveVerifyScript(project: Project | undefined, projectPath: string): string | null   // explicit config only
getEffectiveSetupScript(project: Project | undefined, projectPath: string): string | null    // explicit config only
formatTask(ctx: TaskContext): string
buildFullTaskContext(ctx: TaskContext, progressSummary: string | null, gitHistory: string, verifyScript: string | null, setupStatus?: SetupStatus, preFlightResult?: PreFlightResult): string
getContextFileName(sprintId: string, taskId: string): string
async writeTaskContextFile(projectPath: string, taskContent: string, instructions: string, sprintId: string, taskId: string): Promise<string>
async getProjectForTask(task: Task, sprint: Sprint): Promise<Project | undefined>
runPreFlightCheck(ctx: TaskContext, noCommit: boolean): void
```

**Setup status in task context:** When `setupStatus` is provided, an "Environment Setup" section is rendered telling the
AI agent what happened during stage zero — whether a setup script ran (and which command), or that no script is
configured. This prevents agents from wasting turns re-running `npm install` and helps them discover commands when no
scripts are configured.

**Pre-flight verification in task context:** When `preFlightResult` is provided, a "Pre-Flight Verification" section is
rendered. If passed, the agent knows the environment was clean before it started. If failed-resuming, the agent sees the
failure output and is instructed to assess and fix or signal `<task-blocked>`.

### Runner (`claude/runner.ts`)

Sprint execution harness for `sprint start`. Validates sprint state, reorders tasks by dependencies, then delegates to
the executor. Implements patterns
from [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

```typescript
async runSprint(sprintId?: string, options: RunOptions): Promise<void>

interface RunOptions {
  watch?: boolean;       // Stream Claude output
  session?: boolean;     // Interactive session
  interactive?: boolean; // Pause between tasks (step mode)
  count?: number;        // Limit task count
  noCommit?: boolean;    // Skip auto-commit
  concurrency?: number;  // Max parallel tasks
}
```

**Setup script execution** ("stage zero"):

- Runs before any AI agent starts work — explicit repo config only, no runtime auto-detection
- **Setup tracking:** timestamps recorded in `sprint.setupRanAt` — re-runs skip already-completed setups.
  Use `--refresh-setup` to force re-execution.
- Per-repo persistence: each successful setup is saved immediately via `saveSprint()`, so partial failures are safe
- Fail-fast on multi-repo — partial setup is worse than no setup
- Timeout: 5 minutes default, override via `RALPHCTL_SETUP_TIMEOUT_MS` env var
- Repos without a configured setup script are skipped with a dim warning
- Returns `SetupResults` map (projectPath → `SetupStatus`) — threaded to executor so each AI agent knows what ran
- `setupRanAt` is cleared when the sprint is closed via `closeSprint()`

**Completion signals:**

- `<task-verified>output</task-verified>` — Verification passed (required before completion in headless mode)
- `<task-complete>` — Task finished successfully
- `<task-blocked>reason</task-blocked>` — Task cannot proceed

### Executor (`claude/executor.ts`)

Sequential and parallel task execution orchestrator. Handles task lifecycle, spinner feedback, and progress logging.

```typescript
interface ExecutorOptions {
  step?: boolean;          // Pause between tasks
  count?: number;          // Limit task count
  session?: boolean;       // Interactive session mode
  noCommit?: boolean;      // Skip auto-commit
  concurrency?: number;    // Max parallel tasks (default: one per unique projectPath)
  maxRetries?: number;     // Max retries for rate-limited tasks
  failFast?: boolean;      // Stop on first failure
  refreshSetup?: boolean;  // Force re-run setup scripts even if already ran this sprint
}

interface ExecutionSummary {
  completed: number;
  remaining: number;
  stopReason: StopReason;
  blockedTask?: Task;
  blockedReason?: string;
  exitCode: number;
}

type StopReason = 'all_completed' | 'count_reached' | 'task_blocked' | 'user_paused' | 'no_tasks' | 'all_blocked'

async executeTaskLoop(sprintId: string, options: ExecutorOptions, setupResults?: SetupResults): Promise<ExecutionSummary>
async executeTaskLoopParallel(sprintId: string, options: ExecutorOptions, setupResults?: SetupResults): Promise<ExecutionSummary>
```

**Per-task pre-flight verification** runs the project's `verifyScript` before each AI task starts:

1. No verifyScript → skip (Claude uses CLAUDE.md fallback)
2. Verify passes → `PreFlightResult { status: 'passed' }` — agent told environment is clean
3. Verify fails + task is `todo` → self-heal: re-run `setupScript`, retry verify once
   - Pass → proceed
   - Fail → block task (dependents blocked by existing DAG)
4. Verify fails + task is `in_progress` → `PreFlightResult { status: 'failed-resuming', output }` — agent sees failure

**Parallel execution** launches one task per unique `projectPath` concurrently. Session/step mode forces sequential.
Rate-limited tasks are re-queued (not counted as failures).

### Rate Limiter (`claude/rate-limiter.ts`)

Coordinates rate limit pausing across parallel task executions:

```typescript
class RateLimitCoordinator {
  constructor(options?: { onPause?: (delayMs: number) => void; onResume?: () => void });
  get isPaused(): boolean;
  get remainingMs(): number;
  pause(delayMs: number): void;
  async waitIfPaused(): Promise<void>;
  dispose(): void;
}
```

When a rate limit is detected, the coordinator pauses new task launches while running tasks continue unaffected.

### Permissions (`ai/permissions.ts`)

Tool permission checking — behaviour differs by provider:

**Claude Code** reads settings files and checks allow/deny patterns:

```typescript
interface ProviderPermissions { allow: string[]; deny: string[] }
interface PermissionWarning { tool: string; specifier?: string; message: string }

getProviderPermissions(projectPath, provider?)  // reads settings files (Claude only)
isToolAllowed(permissions, tool, specifier?)    // returns true | false | 'ask'
checkTaskPermissions(projectPath, { verifyScript?, setupScript?, needsCommit? })
```

Settings files checked (Claude only):

- `.claude/settings.local.json` — project-level
- `~/.claude/settings.json` — user-level

**GitHub Copilot** does not use settings files. `getProviderPermissions()` returns empty `{ allow: [], deny: [] }` when
`provider === 'copilot'` — tool access is granted wholesale via the `--allow-all-tools` CLI flag instead.

**Known limitation:** `checkTaskPermissions()` in `src/ai/task-context.ts` does not pass `provider`, so it always runs
the Claude file-read path. For Copilot this is harmless (settings files won't exist) but produces no pre-flight
warnings. If provider-aware warnings are needed in future, thread `provider` through `runPreFlightCheck()` →
`checkTaskPermissions()` → `getProviderPermissions()`.

### Process Manager (`claude/process-manager.ts`)

Singleton managing Claude child processes with graceful shutdown:

```typescript
class ProcessManager {
  static getInstance(): ProcessManager;
  static resetForTesting(): void;
  registerChild(child: ChildProcess): void;
  unregisterChild(child: ChildProcess): void;
  ensureHandlers(): void;
  isShuttingDown(): boolean;
  registerCleanup(callback: () => void): () => void; // returns deregister function
  killAll(signal: NodeJS.Signals): void;
  async shutdown(signal: NodeJS.Signals): Promise<void>;
  dispose(): void;
}
```

Handles SIGINT/SIGTERM with double Ctrl+C force-quit pattern.

### Prompt Templates (`claude/prompts/`)

| Template              | Purpose                                             | Variables                                                                                                         | Mode        |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- |
| `ticket-refine.md`    | Requirements refinement (WHAT, no code exploration) | `{{TICKET}}`, `{{OUTPUT_FILE}}`, `{{SCHEMA}}`                                                                     | Interactive |
| `plan-interactive.md` | Plan tasks with repo selection & iteration          | `{{CONTEXT}}`, `{{OUTPUT_FILE}}`, `{{SCHEMA}}`                                                                    | Interactive |
| `plan-auto.md`        | Headless task generation with repo selection        | `{{CONTEXT}}`, `{{SCHEMA}}`                                                                                       | Auto        |
| `plan-common.md`      | Shared planning context (included by plan prompts)  | `{{CONTEXT}}`                                                                                                     | Both        |
| `ideate.md`           | Interactive single-session refine + plan            | `{{IDEA_TITLE}}`, `{{IDEA_DESCRIPTION}}`, `{{PROJECT_NAME}}`, `{{REPOSITORIES}}`, `{{OUTPUT_FILE}}`, `{{SCHEMA}}` | Interactive |
| `ideate-auto.md`      | Headless single-session refine + plan               | `{{IDEA_TITLE}}`, `{{IDEA_DESCRIPTION}}`, `{{PROJECT_NAME}}`, `{{REPOSITORIES}}`, `{{SCHEMA}}`                    | Auto        |
| `task-execution.md`   | Implement a task                                    | `{{CONTEXT_FILE}}`, `{{PROGRESS_FILE}}`, `{{COMMIT_STEP}}`, `{{COMMIT_CONSTRAINT}}`                               | All modes   |

### Prompt Builders

```typescript
buildTicketRefinePrompt(ticketContent: string, outputFile: string, schema: string): string
buildInteractivePrompt(context: string, outputFile: string, schema: string): string
buildAutoPrompt(context: string, schema: string): string
buildTaskExecutionPrompt(progressFilePath: string, noCommit: boolean, contextFileName: string): string
buildIdeatePrompt(ideaTitle: string, ideaDescription: string, projectName: string, repositories: string, outputFile: string, schema: string): string
buildIdeateAutoPrompt(ideaTitle: string, ideaDescription: string, projectName: string, repositories: string, schema: string): string
```

## Interactive Mode

Interactive mode provides a menu-driven REPL interface with context-aware menus, persistent status headers, and workflow
guidance.

### Menu System (`interactive/menu.ts` & `interactive/index.ts`)

- **Dynamic menus** — Actions enabled/disabled based on current state (e.g., can't plan without tickets)
- **Persistent status header** — Sprint name, status, and progress shown before every menu
- **Workflow ordering** — Actions appear in recommended execution order
- **Badges** — Visual indicators for entity counts and states
- **Dashboard** (`interactive/dashboard.ts`) — Provides dashboard data and next action suggestions
- **Quick Start wizard** (`interactive/wizard.ts`) — Guided multi-step sprint setup flow

### Shared Selectors (`interactive/selectors.ts`)

Reusable entity selectors with donut-themed prompts:

```typescript
selectProject(message?): string | null      // Select project by name
selectSprint(message?, filter?): string | null  // Select sprint by ID, optional status filter
selectTicket(message?): string | null       // Select ticket by ID
selectTask(message?, filter?): string | null    // Select task by ID, optional status filter
selectTaskStatus(message?): TaskStatus      // Select a task status
inputPositiveInt(message): number           // Prompt for a positive integer
selectProjectPaths(projects): string[]      // Multi-select for repository paths
```

All selectors return `null` when no entities are available (with a muted message).
Used by command files for interactive fallback when args are missing.

## File Storage

### Directory Structure

```
~/.ralphctl/                      # Default data directory
├── config.json                   # Global config
├── projects.json                 # Project definitions
└── sprints/
    └── <sprint-id>/              # e.g., 20260204-154532-api-refactor/
        ├── sprint.json           # Sprint + tickets
        ├── tasks.json            # Task array
        ├── progress.md           # Append-only log
        ├── requirements.md       # Exported requirements (via `sprint requirements`)
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
async readValidatedJson<T>(filePath: string, schema: ZodSchema<T>): Promise<T>
async writeValidatedJson<T>(filePath: string, data: T, schema: ZodSchema<T>): Promise<void>
async fileExists(filePath: string): Promise<boolean>
async listDirs(dirPath: string): Promise<string[]>
async appendToFile(filePath: string, content: string): Promise<void>
async readTextFile(filePath: string): Promise<string>
```

**Error classes:**

- `ValidationError`: Zod validation failed
- `FileNotFoundError`: File doesn't exist

### Path Resolution (`utils/paths.ts`)

```typescript
getDataDir(): string                       // RALPHCTL_ROOT env var (direct) or ~/.ralphctl/
getSchemaPath(schemaName): string          // Always resolves from repo root (not data dir)
getProjectsFilePath(): string              // {dataDir}/projects.json
getSprintsDir(): string                    // {dataDir}/sprints
getSprintDir(sprintId): string             // {dataDir}/sprints/<id>
getSprintFilePath(sprintId): string        // .../sprint.json
getTasksFilePath(sprintId): string         // .../tasks.json
getProgressFilePath(sprintId): string      // .../progress.md
getConfigPath(): string                    // {dataDir}/config.json
validateProjectPath(path: string): boolean
```

**Note:** `RALPHCTL_ROOT` overrides the default `~/.ralphctl/` data directory; it points directly to the desired data directory. Schemas always resolve from the repo root via a private `getRepoRoot()` function.

### Exit Codes (`utils/exit-codes.ts`)

```typescript
const EXIT_SUCCESS = 0;      // All operations completed successfully
const EXIT_ERROR = 1;        // Validation failed, execution error
const EXIT_NO_TASKS = 2;     // No tasks available to execute
const EXIT_ALL_BLOCKED = 3;  // All remaining tasks blocked by deps
const EXIT_INTERRUPTED = 130; // SIGINT received (Unix: 128 + 2)

exitWithCode(code: number): never
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
   - **NO code exploration** — pure requirements gathering
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

### Quick Ideation (`sprint ideate`)

Combines refinement and planning in a single Claude session:

1. User provides idea title, description, and target project
2. Claude refines requirements and generates tasks in one pass
3. Tasks imported with dependency validation
4. Supports `--auto` for headless mode

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
| `NoCurrentSprintError` | sprint  | No current sprint set        |
| `TicketNotFoundError`  | ticket  | Invalid ticket ID            |
| `DuplicateTicketError` | ticket  | External ID already exists   |
| `TaskNotFoundError`    | task    | Invalid task ID              |
| `TaskStatusError`      | task    | Invalid status operation     |
| `DependencyCycleError` | task    | Cycle in dependencies        |
| `SpawnError`           | session | Claude process spawn failure |

### CLI Error Handling

- Commands validate input before calling store functions
- Store errors bubble up with descriptive messages
- Sprint state errors include hints for resolution
- Structured exit codes for scripting integration (see Exit Codes)

## Testing

15 test files in `src/**/*.test.ts`:

- `schemas/index.test.ts` — Schema validation (Project, Sprint, Ticket, Task, Config)
- `store/task.test.ts` — Task store (ordering, dependencies, cycles)
- `store/ticket.test.ts` — Ticket store (grouping, filtering)
- `store/progress.test.ts` — Progress store
- `claude/runner.test.ts` — Runner and parser tests
- `claude/session.test.ts` — Session spawning and retry logic
- `claude/rate-limiter.test.ts` — Rate limit coordination
- `claude/process-manager.test.ts` — Process management and signal handling
- `commands/sprint/plan-utils.test.ts` — Planning utility functions
- `utils/ids.test.ts` — ID generation
- `utils/json-extract.test.ts` — JSON extraction from mixed output
- `utils/requirements-export.test.ts` — Requirements markdown export
- `theme/index.test.ts` — Theme constants and quotes
- `integration/cli.test.ts` — Store integration tests
- `integration/cli-smoke.test.ts` — CLI subprocess tests

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
