# RalphCTL - Sprint & Task Management for AI-Assisted Coding

CLI tool for managing sprints and tasks that integrates with Claude Code for AI-assisted implementation workflows.

Featuring Ralph Wiggum personality with fun quotes, themed colors, and an interactive menu mode!

> **Documentation:**
>
> - [REQUIREMENTS.md](./REQUIREMENTS.md) - What the app does, why features exist, design rationale
> - [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical implementation: data models, services, APIs

Check these files for high-level context on the tool's purpose and design.
If you notice inconsistencies or discrepancies, please raise an issue.

## Workflow

```
1. Add projects       → ralphctl project add (define multi-repo projects)
2. Create sprint      → ralphctl sprint create (draft, becomes current)
3. Add tickets        → ralphctl ticket add --project <name> (repeat for each)
4. Refine requirements → ralphctl sprint refine (Claude asks questions, user approves)
5. Plan tasks         → ralphctl sprint plan (Claude explores repos, generates tasks)
6. Start work         → ralphctl sprint start (auto-activates, executes tasks)
7. Close sprint       → ralphctl sprint close (active → closed)
```

Note: `sprint start` auto-activates if the sprint is in draft status.

Tickets can have an optional external ID/link (for issue tracker integration) or be freestyle descriptions. Each ticket references a project by name, enabling multi-project sprints.

### Two Workflow Paths

**Workflow 1: Direct Tasks (Core)**

```
ralphctl sprint create → ralphctl task add (repeat) → ralphctl sprint start
```

Use when you know exactly what needs to be done. Fast and direct.

**Workflow 2: AI-Assisted Planning**

```
ralphctl sprint create → ralphctl ticket add → ralphctl sprint refine → ralphctl sprint plan → ralphctl sprint start
```

Use when you have high-level tickets that need AI help breaking down into tasks.

## Key Concepts

### Projects

Projects are named entities with one or more repositories. Each repository has:

- Auto-derived name (from path basename)
- Absolute path
- Optional setup script (e.g., `npm install`)
- Optional verify script (e.g., `npm test`)

```bash
ralphctl project add --name my-app --display-name "My App" --path ~/frontend --path ~/backend
```

This creates a project with two repositories named "frontend" and "backend". In interactive mode, you'll be prompted to configure setup/verify scripts for each repository based on auto-detection.

Tickets reference projects by name. Tasks get their execution path from a specific repository within the project.

### Multi-Project Sprints

A sprint can contain tickets from multiple projects. Each ticket references a project:

```
Sprint (container)
├── Ticket A (projectName: frontend)
│   └── Tasks 1-3 (projectPath: ~/frontend)
├── Ticket B (projectName: backend)
│   └── Tasks 4-6 (projectPath: ~/backend)
```

### Current Sprint vs Sprint Status

These are two separate concepts:

| Concept            | Purpose                          | Stored In     |
| ------------------ | -------------------------------- | ------------- |
| **Current Sprint** | Which sprint CLI commands target | `config.json` |
| **Sprint Status**  | Lifecycle state of a sprint      | `sprint.json` |

- **Current sprint**: A pointer in config.json. Set by `sprint create` (auto) or `sprint current`
- **Sprint status**: Part of the sprint's lifecycle (draft → active → closed)

Multiple sprints can be active simultaneously (useful for parallel work in different terminals).

### Sprint State Machine

Sprint status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add/edit/rm ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
| Plan/add tasks      |   ✓   |   ✗    |   ✗    |
| Start (execute)     |  ✓\*  |   ✓    |   ✗    |
| Update task status  |   ✗   |   ✓    |   ✗    |
| Close               |   ✗   |   ✓    |   ✗    |

\*`sprint start` auto-activates draft sprints.

### Two-Phase Planning

**Phase 1: Requirements Refinement** (`ralphctl sprint refine`)

Per-ticket Human-In-The-Loop (HITL) clarification focused on WHAT needs to be done:

1. For each pending ticket:
   - Display ticket details (title, description, project)
   - Claude asks clarifying questions about requirements and acceptance criteria
   - User answers via selection UI
   - User reviews and approves refined requirements
2. Requirements stored in tickets, marked `requirementStatus: 'approved'`

This phase is **implementation-agnostic**—no code exploration, no repository selection. It focuses purely on clarifying requirements and acceptance criteria.

**Phase 2: Task Generation** (`ralphctl sprint plan`)

Per-ticket HOW it will be implemented:

1. Requires all tickets to have `requirementStatus: 'approved'`
2. For each ticket:
   - **Claude proposes which repositories are affected** based on approved requirements
   - User reviews and confirms the proposed repositories (checkbox UI)
   - Selection saved to `ticket.affectedRepositories`
   - Claude explores ONLY the confirmed repos
   - Claude generates tasks split by repository with proper dependencies
3. Each task gets a `projectPath` matching one of the affected repos

This phase focuses on implementation approach and task breakdown. The repo selection is persisted, so you can resume planning even if interrupted.

## CLI Commands

### Project

```bash
ralphctl project add [options]               # Add/update project
ralphctl project list                        # List all projects
ralphctl project show <name>                 # Show project details
ralphctl project remove <name> [-y]          # Remove project
ralphctl project repo add <name> <path>      # Add repository to project
ralphctl project repo remove <name> <path>   # Remove repository from project
```

#### Project Add Options

```bash
--name <name>           # Slug (required)
--display-name <name>   # Human-readable name (required)
--path <path>           # Repository path (repeatable)
--description <desc>    # Optional
-n, --no-interactive    # Non-interactive mode
```

In interactive mode, after adding each repository path, you'll be prompted to configure:

- **Setup script** - Command to prepare the repo (e.g., `npm install`)
- **Verify script** - Command to verify changes (e.g., `npm test`)

Scripts are auto-detected based on project type (Node.js, Python, Go, Rust, Java).

### Sprint

```bash
ralphctl sprint create [options]   # Create new sprint (becomes current)
ralphctl sprint list               # List all sprints
ralphctl sprint show               # Show current sprint details
ralphctl sprint context            # Output full context (for planning)
ralphctl sprint current [id|-]     # Show/set current sprint (- opens selector)
ralphctl sprint refine [options]   # Refine ticket requirements (Phase 1)
ralphctl sprint plan [options]     # Plan tasks with Claude (Phase 2)
ralphctl sprint start [options]    # Start implementation loop with Claude
ralphctl sprint close              # Close active sprint
```

#### Sprint Create Options

```bash
--name <name>          # Sprint name (optional, generates uuid8 if omitted)
-n, --no-interactive   # Non-interactive mode
```

#### Sprint ID Format

Sprint IDs are lexicographically sortable timestamps with a human-readable slug:

```
YYYYMMDD-HHmmss-<slug>
```

Examples:

- `20260204-154532-api-refactor` (with name "API Refactor")
- `20260204-154532-a1b2c3d4` (without name, uses uuid8)

This format enables natural sorting by creation time when listing sprints.

#### Sprint Plan Options

```bash
--auto                 # Headless mode (no user interaction)
--all-paths            # Include all project repositories (may be slow)
```

#### Sprint Start Options

```bash
-s, --session         # Interactive Claude session (collaborate with Claude)
-t, --step            # Step through tasks with approval between each
-c, --count <n>       # Limit to N tasks
--no-commit           # Skip auto-commit after task completion
```

### Ticket

```bash
ralphctl ticket add [options]     # Add ticket (interactive or with flags)
ralphctl ticket edit [id]         # Edit existing ticket (opens selector if no id)
ralphctl ticket list [-b]         # List tickets (markdown format, -b for brief)
ralphctl ticket show <id>         # Show ticket details
ralphctl ticket remove <id> [-y]  # Remove ticket (-y to skip confirmation)
```

#### Ticket Add Options

```bash
--project <name>       # Project name (required, shows selector if omitted)
--id <id>              # Optional external ID (e.g., JIRA-123)
--title <title>        # Title/summary (required)
--description <desc>   # Detailed description (recommended)
--link <url>           # Link to external issue (optional)
--editor               # Use editor for multi-line description
-n, --no-interactive   # Non-interactive mode (requires --project and --title)
```

#### Ticket Edit Options

```bash
--title <title>        # New title
--description <desc>   # New description
--link <url>           # New link
--id <id>              # New external ID
-n, --no-interactive   # Non-interactive mode (requires ticket ID argument)
```

### Task

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

#### Task Add Options

```bash
--name <name>          # Task name (required in non-interactive)
--description <desc>   # Description (optional)
--step <step>          # Add a step (repeatable)
--ticket <id>          # Link to ticket ID (inherits projectPath from ticket's project)
--project <path>       # Project path (required unless using --ticket)
-n, --no-interactive   # Non-interactive mode (requires --name)
```

#### Task Status Options

```bash
-n, --non-interactive  # Non-interactive mode (exit with error codes)
```

### Progress

```bash
ralphctl progress log [msg]     # Log progress (opens editor if no message)
ralphctl progress show          # Show progress log
```

### Interactive Mode

Run `ralphctl` with no arguments to enter interactive mode:

```bash
ralphctl                        # Enter interactive menu-driven mode
ralphctl interactive            # Same as above
```

Interactive mode provides a menu-driven interface for navigating all commands.

## Task Import Format

```json
[
  {
    "id": "1",
    "name": "Task name",
    "description": "Optional description",
    "steps": ["Step 1", "Step 2"],
    "ticketId": "abc12345"
  },
  {
    "id": "2",
    "name": "Second task",
    "blockedBy": ["1"]
  }
]
```

- `id`: Local ID for referencing in blockedBy (converted to real ID on import)
- `blockedBy`: Reference earlier tasks by their `id` field (must reference earlier tasks)
- `ticketId`: Optional reference to a ticket's internal ID (task inherits projectPath from ticket's project)

## Data Storage

```
ralphctl-data/              # Git-ignored, all persistent data
├── config.json             # Current/active sprint tracking
├── projects.json           # Project definitions
└── sprints/<sprint-id>/    # e.g., 20260204-154532-api-refactor/
    ├── sprint.json         # Sprint metadata + tickets
    ├── tasks.json          # Task array
    ├── progress.md         # Append-only log
    ├── refinement/         # Created by `sprint refine`
    │   └── <ticket-id>/
    │       ├── refine-context.md             # Prompt/context sent to Claude
    │       └── requirements.json            # Claude's refined requirements
    └── planning/           # Created by `sprint plan`
        ├── planning-context.md  # Prompt/context sent to Claude
        └── tasks.json           # Claude's generated tasks (before import)
```

## Development

```bash
pnpm dev <command>     # Run CLI
pnpm lint              # Lint
pnpm typecheck         # Type check
pnpm test              # Run tests
pnpm test:watch        # Tests in watch mode
pnpm test:coverage     # Tests with coverage report
```

Keep CLAUDE.md updated with CLI Commands and concepts as they evolve.
Update [json schemas](/schemas) for config files when edited.

## Development Agents

This project uses specialized Claude Code agents to assist with development. These are **not** part of ralphctl's runtime—they help YOU build ralphctl.

### Agent Roster

| Agent           | Role                       | Tools       | When to Invoke                                         |
| --------------- | -------------------------- | ----------- | ------------------------------------------------------ |
| **planner**     | Break work into steps      | Read-only   | "How should I implement X?", "Break down this feature" |
| **designer**    | UX design + implementation | All         | New commands, prompts, output formatting, theme code   |
| **implementer** | Business logic             | All         | Features, bugs, refactoring, services                  |
| **tester**      | Test strategy + writing    | All         | Write tests, improve coverage, debug test failures     |
| **reviewer**    | Code quality review        | Read + Bash | Pre-merge review, check for issues                     |
| **auditor**     | Security scanning          | Read + Bash | Security-sensitive changes, audit for vulnerabilities  |

### Development Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                  DEVELOPMENT WORKFLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. PLAN              2. DESIGN           3. IMPLEMENT      │
│  ┌──────────┐         ┌──────────┐        ┌─────────────┐   │
│  │ planner  │ ──────► │ designer │ ─────► │ implementer │   │
│  └──────────┘         └──────────┘        └─────────────┘   │
│  "Break this           "How should         "Write the       │
│   into steps"           the UX work?"       code"           │
│                                                    │        │
│                                                    ▼        │
│  5. AUDIT             4. REVIEW           4. TEST           │
│  ┌──────────┐         ┌──────────┐        ┌──────────┐      │
│  │ auditor  │ ◄────── │ reviewer │ ◄───── │ tester   │      │
│  └──────────┘         └──────────┘        └──────────┘      │
│  "Security             "Quality            "Write tests,    │
│   issues?"              check"              coverage"       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### When Agents Are Invoked

Agents are invoked automatically based on the task, or explicitly by request:

**Automatic delegation** (based on what you ask):

- "Add a --json flag to task list" → **designer** (command structure) + **implementer** (logic)
- "Fix the bug where sprints don't close" → **implementer**
- "Review my changes" → **reviewer**
- "Write tests for the ticket service" → **tester**

**Explicit invocation** (you can request directly):

- "Use the planner to break down the archive feature"
- "Have the auditor check the file handling code"
- "Ask the designer how the export command should work"

### Agent Capabilities

**Read-only agents** (reviewer, auditor, planner):

- Can explore code, run checks (`pnpm test`, `pnpm lint`)
- Cannot modify files—provide feedback only
- Safe for review tasks

**Full-access agents** (designer, implementer, tester):

- Can read, write, and edit files
- Can run commands
- Used for implementation work

### Best Practices

1. **Start with design** - For new commands/features, consult designer first
2. **Plan complex work** - Use planner for multi-file changes
3. **Review before merge** - Run reviewer on your branch
4. **Test coverage** - Use tester after implementing features
5. **Security check** - Run auditor on auth, file I/O, user input handling

## Theme & UX

ralphctl uses a Ralph Wiggum theme with:

- Donut-decorated banner with random quotes
- ASCII icons for entities, actions, and status (professional terminal look)
- Status emojis for task/sprint state indicators
- Consistent field alignment and color usage

### Theme Files

| File                 | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `src/theme/index.ts` | Colors, quotes, emoji, banner constants                  |
| `src/theme/ui.ts`    | UI components (icons, showSuccess, field, spinner, etc.) |

### UX Patterns

Use the helpers from `@src/theme/ui.ts`:

```typescript
import { showSuccess, showError, showEmpty, showNextStep, icons, field } from '@src/theme/ui.ts';

// Success with fields
showSuccess('Sprint created!', [
  ['ID', id],
  ['Name', name],
]);

// Error
showError('Project not found');

// Empty state with hint
showEmpty('tasks', 'Add one with: ralphctl task add');

// Prompts with icons
await input({ message: `${icons.sprint} Sprint name:` });
```

See `.claude/agents/designer.md` for complete UX guidelines.

## Claude CLI Invocation from Node.js

Claude process spawning is centralized in `src/claude/session.ts`:

```typescript
import { spawnClaudeInteractive, spawnClaudeHeadless } from '@src/claude/session.ts';

// Interactive session with initial prompt (single spawn, stdio: inherit)
spawnClaudeInteractive('Read .ralphctl-task-context.md and follow the instructions', {
  cwd: projectPath,
  args: ['--add-dir', '/other/path'],
});

// Headless mode - prompt via stdin, captures output
const output = await spawnClaudeHeadless({
  cwd: projectPath,
  prompt: 'Your prompt content here',
});
```

**Key patterns:**

- Interactive: pass prompt as CLI argument, `stdio: 'inherit'` for full interactivity
- Headless: `-p` (print mode) with prompt via stdin for large content
- `--permission-mode acceptEdits` enables auto-execution without confirmation

**Task execution flow:**

1. Write `.ralphctl-task-context.md` with task info + instructions
2. **Interactive mode:** Tell Claude to read the file, then continue interactively
3. **Headless mode:** Read file content, pass via stdin to Claude

### Known Issues & Fixes

| Issue        | Symptom                                  | Fix                                        |
| ------------ | ---------------------------------------- | ------------------------------------------ |
| Stdin hang   | Process stuck at 0 CPU, never progresses | Add `child.stdin.end()` after spawn        |
| Cache bloat  | Startup takes 1-2min instead of ~5s      | `rm -rf ~/.claude` (or selectively below)  |
| Plugin bloat | Slow startup, high memory                | `rm -rf ~/.claude/plugins ~/.claude/debug` |

**Cache health check:**

```bash
du -sh ~/.claude  # Should be < 10MB for normal operation
```

**Quick startup test:**

```bash
time claude -p "yolo"  # Should complete in ~5s
```

## Agent Harness Design

ralphctl orchestrates Claude agents to execute tasks. The harness design is based on patterns from [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

> **Note:** This section documents how ralphctl implements the harness (for ralphctl contributors).
> The actual agent instructions are in `src/claude/prompts/task-execution.md`.

### Key Implementation Details

**Task context** (`buildFullTaskContext` in `claude/executor.ts`):

- Task specification (name, steps, description)
- Git history (last 20 commits via `getRecentGitHistory`)
- Verification command (explicit or "read CLAUDE.md")
- Progress history (filtered by project)

**Completion signals** (parsed by `parseExecutionResult` in `claude/parser.ts`):

- `<task-verified>` - verification output (required before completion)
- `<task-complete>` - task done
- `<task-blocked>reason</task-blocked>` - task cannot proceed

**Baseline tracking** (`sprint activate`):

- Logs git commit hash for each project path to progress.md
- Enables diffing what changed during the sprint

### Repository Verification Scripts

Each repository within a project can have its own setup and verify scripts:

```
my-app/
├── frontend/  → setupScript: "npm install", verifyScript: "npm test"
├── backend/   → setupScript: "pip install -e .", verifyScript: "pytest"
└── shared/    → setupScript: "pnpm install", verifyScript: "pnpm typecheck"
```

Scripts are configured per-repository during `project add` (interactive mode auto-detects based on project type).

**Resolution order for verification:**

1. Explicit `verifyScript` on the repository (recommended)
2. Auto-detection from package.json/pyproject.toml/etc. (convenience fallback)
3. Agent reads target repository's CLAUDE.md (ultimate fallback)

The Anthropic harness article recommends projects provide their own verification scripts. Auto-detection is a convenience but explicit scripts are preferred.

### Exit Codes

Commands use structured exit codes for scripting and CI/CD integration:

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success (all requested operations completed)         |
| 1    | Error (validation, missing params, execution failed) |
| 2    | No tasks available                                   |
| 3    | All remaining tasks blocked by dependencies          |

### Task Dependency System

Tasks support `blockedBy` dependencies. When executing:

1. Tasks marked `in_progress` are resumed first
2. Only tasks whose dependencies are all `done` can be selected
3. If all remaining tasks are blocked, execution stops with exit code 3

### Atomic Task Updates

Task file operations use file locking to prevent data corruption from concurrent access. This enables:

- Multiple terminals running different sprints
- Safe interruption and resumption with Ctrl+C
