# RalphCTL

Sprint & task management CLI for AI-assisted coding with Claude.

> "Me fail English? That's unpossible!" - Ralph Wiggum

## What is this?

RalphCTL bridges the gap between high-level planning and AI-assisted implementation. It helps you:

- **Organize work into sprints** with clear lifecycles (draft → active → closed)
- **Break down tickets** into actionable tasks with AI assistance
- **Execute tasks** with Claude Code, including verification and auto-commits
- **Track progress** across multiple repositories

## Features

- Two-phase AI planning (refine specs → generate tasks)
- Multi-project/multi-repo support
- Interactive and headless execution modes
- Task dependencies with topological ordering
- File locking for concurrent safety
- Ralph Wiggum themed UI (because work should be fun)

## Installation

```bash
# Clone and install
git clone <repo>
cd ralphctl
pnpm install

# Run in development
pnpm dev <command>
```

## Quick Start

```bash
# 1. Create a project
ralphctl project add --name my-app --path ~/code/my-app

# 2. Create a sprint
ralphctl sprint create --name "v1.0 features"

# 3. Add tickets
ralphctl ticket add --project my-app --title "Add user authentication"

# 4. Refine specs with AI
ralphctl sprint refine

# 5. Plan tasks with AI
ralphctl sprint plan

# 6. Execute with Claude
ralphctl sprint start -s  # Interactive session
```

## CLI Reference

See [CLAUDE.md](./CLAUDE.md) for complete command documentation.

### Key Commands

| Command | Description |
|---------|-------------|
| `ralphctl` | Interactive menu mode |
| `ralphctl project add` | Add a project with repositories |
| `ralphctl sprint create` | Start a new sprint |
| `ralphctl ticket add` | Add work items to sprint |
| `ralphctl sprint refine` | AI-assisted spec refinement |
| `ralphctl sprint plan` | Generate tasks from specs |
| `ralphctl sprint start` | Execute tasks with Claude |

### Two Workflow Paths

**Direct Tasks** - When you know exactly what needs to be done:

```bash
ralphctl sprint create → ralphctl task add (repeat) → ralphctl sprint start
```

**AI-Assisted Planning** - When you have high-level tickets:

```bash
ralphctl sprint create → ralphctl ticket add → ralphctl sprint refine → ralphctl sprint plan → ralphctl sprint start
```

## Development

```bash
pnpm dev <command>    # Run CLI in development
pnpm test             # Run tests
pnpm lint             # Lint code
pnpm typecheck        # Type check
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details.

```
src/
├── cli.ts            # Entry point
├── commands/         # CLI commands
├── store/            # Data persistence layer
├── claude/           # Claude Code integration
├── interactive/      # REPL mode
├── theme/            # Ralph Wiggum theming
└── utils/            # Utilities
```

## Requirements

- Node.js 18+
- Claude Code CLI (`claude`) installed and configured
