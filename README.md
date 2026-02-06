![Node.js](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![CLI](https://img.shields.io/badge/CLI-pnpm-orange)

```
  🍩 ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗ ██████╗████████╗██╗     🍩
     ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║██╔════╝╚══██╔══╝██║
     ██████╔╝███████║██║     ██████╔╝███████║██║        ██║   ██║
     ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║██║        ██║   ██║
     ██║  ██║██║  ██║███████╗██║     ██║  ██║╚██████╗   ██║   ███████╗
     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝
```

**Sprint & task management CLI for AI-assisted coding with Claude.**

> _"I'm helping!"_ — Ralph Wiggum

RalphCTL bridges the gap between high-level planning and AI-assisted implementation. Organize work into sprints, break down tickets into tasks with Claude's help, and execute them — all from the terminal, with a Ralph Wiggum personality to keep things fun.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Overview](#cli-overview)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **AI-Assisted Planning** — Two-phase workflow: refine requirements with Claude, then generate implementation tasks automatically
- **Multi-Project Sprints** — Manage tickets across multiple repositories within a single sprint
- **Task Dependencies** — Define `blockedBy` relationships between tasks with topological ordering
- **Interactive & Headless Modes** — Collaborate with Claude interactively or run fully automated
- **Sprint Lifecycle** — Clean state machine (draft → active → closed) with concurrent-safe file locking
- **Interactive Menu Mode** — Run `ralphctl` with no arguments for a menu-driven experience
- **Ralph Wiggum Personality** — Donut-themed banner, random quotes, and themed UI because work should be fun

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) **>= 24.0.0**
- [pnpm](https://pnpm.io/) package manager
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) installed and configured

### Install from Source

```bash
# Clone the repository
git clone https://github.com/grigis/ralphctl.git
cd ralphctl

# Install dependencies
pnpm install

# Run in development mode
pnpm dev --help
```

---

## Quick Start

### Workflow 1: Direct Tasks

Use when you know exactly what needs to be done.

```bash
# 1. Set up a project
ralphctl project add --name my-app --display-name "My App" --path ~/code/my-app

# 2. Create a sprint
ralphctl sprint create --name "quick-fixes"

# 3. Add tasks directly
ralphctl task add --name "Fix login bug" --project ~/code/my-app

# 4. Execute with Claude
ralphctl sprint start -s
```

### Workflow 2: AI-Assisted Planning

Use when you have high-level tickets that need AI help breaking down into tasks.

```bash
# 1. Set up a project (if not already done)
ralphctl project add --name my-app --display-name "My App" --path ~/code/frontend --path ~/code/backend

# 2. Create a sprint
ralphctl sprint create --name "v1.0-features"

# 3. Add tickets
ralphctl ticket add --project my-app --title "Add user authentication"
ralphctl ticket add --project my-app --title "Implement search API"

# 4. Refine requirements with AI (clarify WHAT)
ralphctl sprint refine

# 5. Plan tasks with AI (decide HOW, select affected repos)
ralphctl sprint plan

# 6. Execute tasks with Claude
ralphctl sprint start -s    # Interactive session
ralphctl sprint start       # Headless (fully automated)
```

---

## CLI Overview

| Command                  | Description                              |
| ------------------------ | ---------------------------------------- |
| `ralphctl`               | Interactive menu mode                    |
| `ralphctl project add`   | Add a project with repositories          |
| `ralphctl sprint create` | Start a new sprint                       |
| `ralphctl ticket add`    | Add work items to a sprint               |
| `ralphctl sprint refine` | AI-assisted requirements refinement      |
| `ralphctl sprint plan`   | Generate tasks from refined requirements |
| `ralphctl sprint start`  | Execute tasks with Claude                |
| `ralphctl sprint close`  | Close an active sprint                   |
| `ralphctl task list`     | List tasks in the current sprint         |
| `ralphctl task next`     | Get the next available task              |

For the full command reference, see [CLAUDE.md](./CLAUDE.md#cli-commands).

---

## Documentation

| Document                             | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| [CLAUDE.md](./CLAUDE.md)             | Full CLI command reference, data model, and developer guide |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | Feature rationale and design decisions                      |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture, data models, and service APIs       |

---

## Development

```bash
pnpm dev <command>     # Run CLI in development mode
pnpm test              # Run tests
pnpm test:watch        # Tests in watch mode
pnpm test:coverage     # Tests with coverage report
pnpm lint              # Lint
pnpm typecheck         # Type check
```

### Project Structure

```
src/
├── cli.ts            # Entry point
├── commands/         # CLI command definitions
├── store/            # Data persistence layer
├── claude/           # Claude Code integration (session, executor, prompts)
├── interactive/      # REPL / menu mode
├── schemas/          # Zod schemas and validation
├── theme/            # Ralph Wiggum theming (colors, banner, quotes)
└── utils/            # Utilities (IDs, file locking, exit codes)
```

---

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and ensure all checks pass (`pnpm lint && pnpm typecheck && pnpm test`)
4. Commit your changes
5. Open a pull request

---

## License

MIT
