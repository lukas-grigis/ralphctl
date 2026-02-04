# Implementer Memory

## Code Organization

```
src/
├── commands/          # CLI commands by entity (sprint/, task/, ticket/, project/)
├── store/             # Data access layer (task.ts, sprint.ts, ticket.ts, project.ts)
├── schemas/           # Zod schemas and TypeScript types (index.ts)
├── theme/             # UI helpers (index.ts = colors/quotes, ui.ts = formatting)
├── utils/             # Utilities (paths.ts, storage.ts, ids.ts, file-lock.ts)
├── interactive/       # Interactive mode (menu.ts, selectors.ts)
└── claude/            # Claude integration (session.ts, executor.ts, runner.ts)
```

## TypeScript Patterns

### Zod Schemas (src/schemas/index.ts)

- All data models defined with Zod schemas
- Export both schema and inferred type: `TaskSchema` + `type Task`
- Use `.default()` for optional fields with defaults
- Use `.regex()` for ID format validation

```typescript
export const TaskStatusSchema = z.enum(['todo', 'in_progress', 'done']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
```

### Custom Error Classes (src/store/\*.ts)

- Extend `Error` with typed properties
- Set `this.name` for proper stack traces

```typescript
export class TaskNotFoundError extends Error {
  public readonly taskId: string;
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}
```

### File Locking (src/utils/file-lock.ts)

- Use `withFileLock()` for atomic read-modify-write operations
- Prevents race conditions in concurrent access

```typescript
return withFileLock(tasksFilePath, async () => {
  const tasks = await getTasks(id);
  // modify tasks
  await saveTasks(tasks, id);
  return result;
});
```

### Storage Pattern (src/utils/storage.ts)

- `readValidatedJson(path, schema)` - reads and validates with Zod
- `writeValidatedJson(path, data, schema)` - validates before writing

## CLI Command Pattern

Commands are thin wrappers that:

1. Parse args (check for flags like `-b`, `--brief`)
2. Call store functions for data
3. Use theme/ui.ts for output

```typescript
// src/commands/task/list.ts
export async function taskListCommand(args: string[] = []): Promise<void> {
  const brief = args.includes('-b') || args.includes('--brief');
  const tasks = await listTasks();

  if (tasks.length === 0) {
    showEmpty('tasks', 'Add one with: ralphctl task add');
    return;
  }
  // ... format and output
}
```

## Data Flow

```
Command → Store → Schema validation → JSON file
                ↓
           file-lock.ts (for writes)
```

## Key Dependencies

| Package             | Usage                                |
| ------------------- | ------------------------------------ |
| `zod`               | Schema validation, type inference    |
| `commander`         | CLI argument parsing (in cli.ts)     |
| `@inquirer/prompts` | Interactive prompts                  |
| `colorette`         | Terminal colors (via theme/index.ts) |
| `ora`               | Spinners (via theme/ui.ts)           |

## ID Generation

- `generateUuid8()` from `src/utils/ids.ts` - 8-char random IDs
- Sprint IDs: `YYYYMMDD-HHmmss-<slug>` format

## Common Pitfalls

1. **Always use file lock** for store operations that modify data
2. **Check sprint status** before mutations with `assertSprintStatus()`
3. **Resolve sprint ID** first with `resolveSprintId()` - handles "current" sprint
4. **Import paths** use `@src/` alias (configured in tsconfig)
