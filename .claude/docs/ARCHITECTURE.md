# RalphCTL - Architecture

Data models, file storage, and reference tables. For constraints, see the root CLAUDE.md. For acceptance criteria,
see [REQUIREMENTS.md](./REQUIREMENTS.md).

## Data Models

All types defined in `src/schemas/index.ts` (Zod) with JSON schema mirrors in `/schemas/`.

### Project

```typescript
interface Project {
  name: string; // Slug ID (lowercase alphanumeric + hyphens)
  displayName: string;
  repositories: Repository[]; // At least one required
  description?: string;
}

interface Repository {
  name: string; // Auto-derived from basename(path)
  path: string; // Absolute path (validated as existing directory)
  checkScript?: string; // e.g., "pnpm install && pnpm typecheck && pnpm lint && pnpm test"
  checkTimeout?: number; // Per-repo timeout in ms (overrides RALPHCTL_SETUP_TIMEOUT_MS)
}
```

### Sprint

```typescript
interface Sprint {
  id: string; // Format: YYYYMMDD-HHmmss-<slug>
  name: string;
  status: 'draft' | 'active' | 'closed';
  createdAt: string; // ISO8601
  activatedAt: string | null;
  closedAt: string | null;
  tickets: Ticket[];
  checkRanAt: Record<string, string>; // projectPath → ISO8601 (cleared on close)
  branch: string | null; // Sprint branch name (null = no branch management)
}
```

### Ticket

```typescript
interface Ticket {
  id: string; // UUID8 (auto-generated)
  title: string;
  description?: string;
  link?: string; // Validated as URL
  projectName: string; // References Project.name
  affectedRepositories?: string[]; // Absolute paths, set by sprint plan
  requirementStatus: 'pending' | 'approved';
  requirements?: string; // Set by sprint refine
}
```

### Task

```typescript
interface Task {
  id: string; // UUID8
  name: string;
  description?: string;
  steps: string[];
  verificationCriteria: string[]; // Grading contract surfaced to the evaluator
  status: 'todo' | 'in_progress' | 'done';
  order: number; // 1-indexed
  ticketId?: string;
  blockedBy: string[]; // Dependency task IDs
  projectPath: string; // Execution directory
  verified: boolean; // Default: false
  verificationOutput?: string;
  evaluated: boolean; // Default: false — whether evaluator ran
  evaluationOutput?: string; // Preview (truncated to 2000 chars); full critique lives in evaluationFile
  evaluationStatus?: 'passed' | 'failed' | 'malformed'; // 'malformed' = no parseable signal (distinct from failure)
  evaluationFile?: string; // Sidecar path: <sprintDir>/evaluations/<taskId>.md
}
```

### Config

```typescript
interface Config {
  currentSprint: string | null;
  aiProvider: 'claude' | 'copilot' | null;
  editor: string | null;
  evaluationIterations?: number; // 0 = disabled, default fallback: 1
}
```

## File Storage

```
~/.ralphctl/                          # Default (override with RALPHCTL_ROOT)
├── config.json
├── projects.json
├── insights/                         # sprint insights --export target
│   └── <sprint-id>.md
└── sprints/
    └── <sprint-id>/
        ├── sprint.json               # Sprint + tickets
        ├── tasks.json
        ├── progress.md               # Append-only log
        ├── requirements.md           # Exported via `sprint requirements`
        ├── evaluations/              # Full untruncated evaluator critiques (one file per task)
        │   └── <task-id>.md
        ├── ideation/<ticket-id>/
        │   ├── ideate-context.md
        │   └── output.json
        ├── refinement/<ticket-id>/
        │   ├── refine-context.md
        │   └── requirements.json
        └── planning/
            ├── planning-context.md
            └── tasks.json            # Generated tasks (before import)
```

## Error Classes

All domain errors extend `DomainError` (from `src/errors.ts`) and carry a machine-readable `code` plus optional `cause`.

| Class                  | Group       | Cause                                                                  |
| ---------------------- | ----------- | ---------------------------------------------------------------------- |
| `ProjectNotFoundError` | not-found   | Invalid project name                                                   |
| `ProjectExistsError`   | lifecycle   | Project name already exists                                            |
| `SprintNotFoundError`  | not-found   | Invalid sprint ID                                                      |
| `SprintStatusError`    | lifecycle   | Invalid status for operation                                           |
| `NoCurrentSprintError` | lifecycle   | No current sprint set                                                  |
| `TicketNotFoundError`  | not-found   | Invalid ticket ID                                                      |
| `TaskNotFoundError`    | not-found   | Invalid task ID                                                        |
| `TaskStatusError`      | lifecycle   | Invalid task status operation                                          |
| `DependencyCycleError` | task        | Cycle detected in task `blockedBy` graph                               |
| `NotFoundError`        | not-found   | Generic not-found (repositories, config keys, etc.)                    |
| `ValidationError`      | storage     | Zod validation failed (carries `path`)                                 |
| `ParseError`           | storage     | JSON / output parser rejection                                         |
| `StorageError`         | storage     | Read/write failure in the store layer                                  |
| `IOError`              | storage     | Low-level filesystem error                                             |
| `LockError`            | storage     | File-lock contention or stale lock (carries `lockPath`)                |
| `ProviderError`        | ai-provider | Provider misconfiguration (missing binary, bad settings)               |
| `SpawnError`           | ai-provider | AI process spawn failure (carries `stderr`, `exitCode`, `rateLimited`) |
| `IssueFetchError`      | external    | Failed to fetch an external issue (GitHub, JIRA)                       |

## Exit Codes

| Code | Constant           | Meaning                       |
| ---- | ------------------ | ----------------------------- |
| 0    | `EXIT_SUCCESS`     | All operations completed      |
| 1    | `EXIT_ERROR`       | Validation or execution error |
| 2    | `EXIT_NO_TASKS`    | No tasks available            |
| 3    | `EXIT_ALL_BLOCKED` | All remaining tasks blocked   |
| 130  | `EXIT_INTERRUPTED` | SIGINT received               |
