# RalphCTL - Scope & Task Management for AI-Assisted Coding

CLI tool for managing scopes and tasks that integrates with Claude Code for AI-assisted implementation workflows.

## Workflow

```
1. Create scope      → ralphctl scope create
2. Add tickets       → ralphctl ticket add (repeat for each)
3. Plan tasks        → /scope-plan (Claude helps break down tickets)
4. Import tasks      → ralphctl task import tasks.json
5. Activate scope    → ralphctl scope activate
6. Start work        → /scope-start (loop through tasks)
7. Close scope       → ralphctl scope close
```

## Skills

| Skill           | Description                               |
|-----------------|-------------------------------------------|
| `/scope-create` | Create a new scope                        |
| `/scope-plan`   | Plan tasks based on tickets (uses Claude) |
| `/scope-start`  | Run implementation loop                   |
| `/task-add`     | Add single task interactively             |
| `/task-next`    | Get next task to work on                  |

## CLI Commands

### Scope

```bash
ralphctl scope create          # Create new scope
ralphctl scope list            # List all scopes
ralphctl scope show            # Show active scope details
ralphctl scope context         # Output full context (for planning)
ralphctl scope activate        # Activate draft scope
ralphctl scope start [-i] [-n N]  # Start implementation loop
ralphctl scope close           # Close active scope
```

### Task

```bash
ralphctl task add               # Add task interactively
ralphctl task import <file>     # Import tasks from JSON
ralphctl task list              # List all tasks
ralphctl task show <id>         # Show task details
ralphctl task status <id> <s>   # Update status (todo/in_progress/testing/done)
ralphctl task next              # Get next task
ralphctl task remove <id>       # Remove task
ralphctl task reorder <id> <n>  # Change priority
```

### Ticket

```bash
ralphctl ticket add             # Add ticket interactively
ralphctl ticket list [-v]       # List tickets (-v for full details)
ralphctl ticket show <id>       # Show ticket details
ralphctl ticket remove <id>     # Remove ticket
```

### Progress

```bash
ralphctl progress log <msg>     # Log progress
ralphctl progress show          # Show progress log
```

## Task Import Format

```json
[
  {
    "name": "Task name",
    "description": "Optional description",
    "steps": [
      "Step 1",
      "Step 2"
    ],
    "ticketId": "TICKET-001"
  }
]
```

## Data Storage

```
ralphctl/
├── scopes/<scope-id>/
│   ├── scope.json       # Scope metadata + tickets
│   ├── tasks.json       # Task array
│   └── progress.md      # Append-only log
└── config.json          # Active scope tracking
```

## Development

```bash
pnpm dev <command>     # Run CLI
pnpm lint              # Lint
pnpm typecheck         # Type check
```
