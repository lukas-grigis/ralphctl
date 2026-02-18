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

**Sprint and task management CLI for AI-assisted coding with Claude Code or GitHub Copilot.**

> _"I'm helping!"_ — Ralph Wiggum

> [!NOTE]
> **Early access.** RalphCTL is under active development. Things work, but expect rough edges and breaking changes before 1.0.

You write tickets, your AI buddy (Claude or Copilot) refines the requirements, then breaks them into tasks and executes them. RalphCTL keeps track of the state so nothing gets lost between sessions. Ralph Wiggum personality included because why not.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [CLI Overview](#cli-overview)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## Features

- **Two-phase planning** — clarify requirements first (what), then generate tasks (how), with a human approval gate between them
- **Multi-repo sprints** — a single sprint can track tickets across multiple repositories
- **Task dependencies** — `blockedBy` references with topological sort; tasks run in the right order
- **Interactive or headless** — pair with Claude in a session, or let it run unattended
- **Sprint lifecycle** — state machine (draft -> active -> closed) with file locking for concurrent safety
- **Parallel execution** — one task per repo at a time, with automatic rate limit backoff and session resume
- **Menu mode** — run `ralphctl` with no arguments for an interactive menu

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) **>= 24.0.0**
- [pnpm](https://pnpm.io/) package manager
- Either:
  - [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — for Claude Code
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (`copilot`) — for GitHub Copilot

### Install from Source

```bash
git clone https://github.com/grigis/ralphctl.git
cd ralphctl
pnpm install

# Run in development mode
pnpm dev --help
```

---

## Quick Start

### Workflow 1: Direct Tasks

When you already know what needs doing.

```bash
# 1. Register a project
ralphctl project add --name my-app --display-name "My App" --path ~/code/my-app

# 2. Create a sprint
ralphctl sprint create --name "quick-fixes"

# 3. Add tasks directly
ralphctl task add --name "Fix login bug" --project ~/code/my-app

# 4. Run them
ralphctl sprint start -s
```

### Workflow 2: AI-Assisted Planning

When you have vague tickets that need breaking down.

```bash
# 1. Register a project (if not already done)
ralphctl project add --name my-app --display-name "My App" --path ~/code/frontend --path ~/code/backend

# 2. Create a sprint
ralphctl sprint create --name "v1.0-features"

# 3. Add tickets
ralphctl ticket add --project my-app --title "Add user authentication"
ralphctl ticket add --project my-app --title "Implement search API"

# 4. Refine requirements with Claude (clarify WHAT)
ralphctl sprint refine

# 5. Plan tasks with Claude (decide HOW, pick affected repos)
ralphctl sprint plan

# 6. Execute
ralphctl sprint start -s    # Interactive session
ralphctl sprint start       # Headless (fully automated)
```

---

## AI Provider Configuration

RalphCTL supports **Claude Code** and **GitHub Copilot** as AI backends. Both providers share the same prompt templates and workflow — just pick your preferred assistant.

### Set Your Preferred Provider

```bash
# Use Claude Code
ralphctl config set provider claude

# Use GitHub Copilot
ralphctl config set provider copilot

# View current configuration
ralphctl config show
```

### First-Run Behavior

If no provider is configured, ralphctl prompts you to choose on first command that requires AI assistance (e.g., `sprint refine`, `sprint plan`, `sprint start`). Your selection is saved globally.

### Requirements

- **Claude Code:** Install the `claude` CLI and authenticate ([docs](https://docs.anthropic.com/en/docs/claude-code))
- **GitHub Copilot:** Install the `copilot` CLI and authenticate ([docs](https://docs.github.com/en/copilot/github-copilot-in-the-cli))

Both CLIs must be in your PATH.

---

## CLI overview

| Command                  | Description                      |
| ------------------------ | -------------------------------- |
| `ralphctl`               | Interactive menu mode            |
| `ralphctl config show`   | Show current configuration       |
| `ralphctl config set`    | Set configuration values         |
| `ralphctl project add`   | Register a project and its repos |
| `ralphctl sprint create` | Create a new sprint              |
| `ralphctl ticket add`    | Add a work item to a sprint      |
| `ralphctl sprint refine` | Refine requirements with AI      |
| `ralphctl sprint plan`   | Generate tasks from requirements |
| `ralphctl sprint start`  | Execute tasks with AI            |
| `ralphctl sprint close`  | Close an active sprint           |
| `ralphctl task list`     | List tasks in the current sprint |
| `ralphctl task next`     | Show the next unblocked task     |

Run `ralphctl <command> --help` for details on any command.

---

## Documentation

| Document                             | Description                                       |
| ------------------------------------ | ------------------------------------------------- |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | Feature rationale and design decisions            |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Technical architecture, data models, service APIs |
| [CLAUDE.md](./CLAUDE.md)             | Developer guide and Claude Code project config    |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute                                 |
| [CHANGELOG.md](./CHANGELOG.md)       | Version history                                   |

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

---

## Contributing

Contributions are welcome! Please **open an issue first** to discuss what you'd like to change.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide — dev setup, code style, and PR process.

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md) code of conduct.

---

## Security

To report a vulnerability, use [GitHub's private reporting](https://github.com/grigis/ralphctl/security/advisories/new). See [SECURITY.md](./SECURITY.md) for details.

---

## License

MIT — see [LICENSE](./LICENSE) for details.
