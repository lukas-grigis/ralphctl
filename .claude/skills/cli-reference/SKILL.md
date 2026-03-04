---
name: cli-reference
description: Complete CLI command reference with all flags, options, and subcommands
---

# CLI Command Reference

## Project

```bash
ralphctl project add [options]               # Add/update project
ralphctl project list                        # List all projects
ralphctl project show <name>                 # Show project details
ralphctl project remove <name> [-y]          # Remove project
ralphctl project repo add <name> <path>      # Add repository to project
ralphctl project repo remove <name> <path>   # Remove repository from project
```

### Project Add Options

```bash
--name <name>           # Slug (required)
--display-name <name>   # Human-readable name (required)
--path <path>           # Repository path (repeatable)
--description <desc>    # Optional
-n, --no-interactive    # Non-interactive mode
```

In interactive mode, after adding each repository path, you'll be prompted to configure:

- **Check script** - Command to verify the repo state (e.g., `npm install && npm test`)

Scripts are auto-detected based on project type (Node.js, Python, Go, Rust, Java).

## Sprint

```bash
ralphctl sprint create [options]        # Create new sprint (becomes current)
ralphctl sprint list [--status <s>]     # List all sprints (filter by draft/active/closed)
ralphctl sprint show [id]               # Show current sprint details
ralphctl sprint context [id]            # Output full context (for planning)
ralphctl sprint current [id|-]          # Show/set current sprint (- opens selector)
ralphctl sprint switch                  # Quick sprint switcher (opens selector)
ralphctl sprint refine [id] [options]   # Refine ticket requirements (Phase 1)
ralphctl sprint ideate [id] [options]   # Quick idea to tasks (refine + plan in one session)
ralphctl sprint plan [id] [options]     # Plan tasks with AI (Phase 2)
ralphctl sprint requirements [id]       # Export refined requirements to markdown file
ralphctl sprint health                  # Check sprint health (blockers, stale tasks)
ralphctl sprint start [id] [options]    # Start implementation loop with AI
ralphctl sprint close [id] [options]    # Close active sprint
ralphctl sprint delete [id] [-y]        # Delete a sprint permanently
```

### Sprint Create Options

```bash
--name <name>          # Sprint name (optional, generates uuid8 if omitted)
-n, --no-interactive   # Non-interactive mode
```

### Sprint ID Format

Sprint IDs are lexicographically sortable timestamps with a human-readable slug:

```
YYYYMMDD-HHmmss-<slug>
```

Examples:

- `20260204-154532-api-refactor` (with name "API Refactor")
- `20260204-154532-a1b2c3d4` (without name, uses uuid8)

### Sprint Plan Options

```bash
--auto                 # Headless mode (no user interaction)
--all-paths            # Include all project repositories (may be slow)
```

### Sprint Ideate Options

```bash
--auto                 # Headless mode (no user interaction)
--all-paths            # Include all project repositories
--project <name>       # Pre-select project (skip interactive selection)
```

### Sprint Close Options

```bash
--create-pr            # Create pull requests for sprint branches
```

### Sprint Start Options

```bash
-s, --session          # Interactive AI session (collaborate with your AI provider)
-t, --step             # Step through tasks with approval between each
-c, --count <n>        # Limit to N tasks
--no-commit            # Skip auto-commit after task completion
--concurrency <n>      # Max parallel tasks (default: auto based on unique repos)
--max-retries <n>      # Max rate-limit retries per task (default: 5)
--fail-fast            # Stop launching new tasks on first failure
-f, --force            # Skip precondition checks (e.g., unplanned tickets)
--refresh-check        # Force re-run check scripts even if already ran this sprint
-b, --branch           # Create sprint branch (ralphctl/<sprint-id>) in all repos
--branch-name <name>   # Use a custom branch name for sprint execution
```

## Ticket

```bash
ralphctl ticket add [options]     # Add ticket (interactive or with flags)
ralphctl ticket edit [id]         # Edit existing ticket (opens selector if no id)
ralphctl ticket list [-b]         # List tickets (markdown format, -b for brief)
ralphctl ticket show <id>         # Show ticket details
ralphctl ticket remove <id> [-y]  # Remove ticket (-y to skip confirmation)
```

### Ticket Add Options

```bash
--project <name>       # Project name (required, shows selector if omitted)
--id <id>              # Optional external ID (e.g., JIRA-123)
--title <title>        # Title/summary (required)
--description <desc>   # Detailed description (recommended)
--link <url>           # Link to external issue (optional)
--editor               # Use editor for multi-line description
-n, --no-interactive   # Non-interactive mode (requires --project and --title)
```

### Ticket Edit Options

```bash
--title <title>        # New title
--description <desc>   # New description
--link <url>           # New link
--id <id>              # New external ID
-n, --no-interactive   # Non-interactive mode (requires ticket ID argument)
```

## Task

```bash
ralphctl task add [options]     # Add task (interactive or with flags)
ralphctl task import <file>     # Import tasks from JSON
ralphctl task list [-b]         # List tasks (markdown format, -b for brief)
ralphctl task show <id>         # Show task details
ralphctl task status <id> <s>   # Update status (todo/in_progress/done)
ralphctl task next              # Get next task
ralphctl task remove <id> [-y]  # Remove task (-y to skip confirmation)
ralphctl task reorder <id> <n>  # Change priority
```

### Task Add Options

```bash
--name <name>          # Task name (required in non-interactive)
--description <desc>   # Description (optional)
--step <step>          # Add a step (repeatable)
--ticket <id>          # Link to ticket ID (inherits projectPath from ticket's project)
--project <path>       # Project path (required unless using --ticket)
-n, --no-interactive   # Non-interactive mode (requires --name)
```

### Task Status Options

```bash
-n, --non-interactive  # Non-interactive mode (exit with error codes)
```

## Progress

```bash
ralphctl progress log [msg]     # Log progress (opens editor if no message)
ralphctl progress show          # Show progress log
```

## Dashboard

```bash
ralphctl dashboard    # Show current sprint overview
ralphctl status       # Alias for dashboard
```

Displays current sprint status, ticket/task counts, and task progress bar. Shows a helpful empty state if no current
sprint exists.

## Completion

```bash
ralphctl completion install     # Enable shell tab-completion (bash, zsh, fish)
ralphctl completion uninstall   # Remove shell tab-completion
```

Tab-completion introspects the Commander program tree at completion time — completions stay in sync with commands
automatically. Dynamic completions include project names (`--project`), sprint IDs (positional args), status enums
(`--status`), and config keys/values (`config set`).

## Doctor

```bash
ralphctl doctor                 # Run all environment health checks
```

Checks performed:

- **Node.js version** — verifies >= 24.0.0
- **Git installation** — verifies `git` is in PATH
- **Git identity** — checks `user.name` and `user.email` are configured (warn if missing)
- **AI provider** — checks configured provider binary (`claude` or `copilot`) is in PATH
- **Data directory** — verifies `~/.ralphctl/` (or `RALPHCTL_ROOT`) is accessible and writable
- **Project paths** — validates all registered repository paths exist and are git repos
- **Current sprint** — validates the current sprint file exists and parses correctly

Status values: `pass`, `warn`, `fail`, `skip`. Exit code is non-zero only on failures (warnings don't affect exit code).

## Interactive Mode

```bash
ralphctl                        # Enter interactive menu-driven mode
ralphctl interactive            # Same as above
```

Interactive mode provides a menu-driven interface for navigating all commands.
