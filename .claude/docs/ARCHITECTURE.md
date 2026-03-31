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
  externalId?: string; // JIRA-123, GH-456
  title: string;
  description?: string;
  link?: string;
  projectName: string; // References Project.name
  requirementStatus: 'pending' | 'approved';
  requirements?: string; // Set by sprint refine
  affectedRepositories?: string[]; // Absolute paths, set by sprint plan
}
```

### Task

```typescript
interface Task {
  id: string; // UUID8
  name: string;
  description?: string;
  steps: string[];
  status: 'todo' | 'in_progress' | 'done';
  order: number; // 1-indexed
  ticketId?: string;
  blockedBy: string[]; // Dependency task IDs
  projectPath: string; // Execution directory
  verified: boolean; // Default: false
  verificationOutput?: string;
  evaluated: boolean; // Default: false — whether evaluator ran
  evaluationOutput?: string; // Evaluator critique/output (truncated to 2000 chars)
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
└── sprints/
    └── <sprint-id>/
        ├── sprint.json               # Sprint + tickets
        ├── tasks.json
        ├── progress.md               # Append-only log
        ├── requirements.md           # Exported via `sprint requirements`
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

| Class                  | Module  | Cause                        |
| ---------------------- | ------- | ---------------------------- |
| `ProjectNotFoundError` | project | Invalid project name         |
| `ProjectExistsError`   | project | Name already exists          |
| `SprintNotFoundError`  | sprint  | Invalid sprint ID            |
| `SprintStatusError`    | sprint  | Invalid status for operation |
| `NoCurrentSprintError` | sprint  | No current sprint set        |
| `TicketNotFoundError`  | ticket  | Invalid ticket ID            |
| `DuplicateTicketError` | ticket  | External ID already exists   |
| `TaskNotFoundError`    | task    | Invalid task ID              |
| `TaskStatusError`      | task    | Invalid status operation     |
| `DependencyCycleError` | task    | Cycle in dependencies        |
| `ValidationError`      | storage | Zod validation failed        |
| `FileNotFoundError`    | storage | File missing                 |
| `SpawnError`           | session | AI process spawn failure     |

## Exit Codes

| Code | Constant           | Meaning                       |
| ---- | ------------------ | ----------------------------- |
| 0    | `EXIT_SUCCESS`     | All operations completed      |
| 1    | `EXIT_ERROR`       | Validation or execution error |
| 2    | `EXIT_NO_TASKS`    | No tasks available            |
| 3    | `EXIT_ALL_BLOCKED` | All remaining tasks blocked   |
| 130  | `EXIT_INTERRUPTED` | SIGINT received               |
