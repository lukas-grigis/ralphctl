[![CI](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml/badge.svg)](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml)
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

- [Node.js](https://nodejs.org/) **>= 24.0.0** (managed via [mise](https://mise.jdx.dev/) — see `mise.toml`)
- [pnpm](https://pnpm.io/) **>= 10**
- Either:
  - [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — for Claude Code
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) (`copilot`) — for GitHub Copilot

### Clone & Install

```bash
git clone https://github.com/lukas-grigis/ralphctl.git
cd ralphctl
pnpm install
```

### Make `ralphctl` Available on Your PATH

**Option A — pnpm link (recommended):**

```bash
pnpm link --global
ralphctl --help          # works from anywhere
```

**Option B — add `bin/` to your PATH:**

```bash
# Add to ~/.zshrc or ~/.bashrc
export PATH="/path/to/ralphctl/bin:$PATH"
```

**Option C — development mode only:**

```bash
pnpm dev --help          # runs via tsx, no global install needed
```

### Verify Installation

```bash
ralphctl --version       # prints version
ralphctl --help          # shows all commands
ralphctl                 # interactive menu mode
```

### Data Directory

RalphCTL stores all sprint, project, and task data in `~/.ralphctl/` by default:

```
~/.ralphctl/
├── config.json          # Global config (current sprint, AI provider)
├── projects.json        # Project definitions
└── sprints/             # Per-sprint directories
    └── <sprint-id>/
        ├── sprint.json  # Sprint + tickets
        ├── tasks.json   # Task array
        └── progress.md  # Append-only log
```

To store data elsewhere, set the `RALPHCTL_ROOT` environment variable:

```bash
export RALPHCTL_ROOT="/path/to/custom/data-dir"
```

When set, ralphctl stores data files (`config.json`, `projects.json`, `sprints/`) directly in the specified directory. Schemas and other repo assets always resolve from the installed repo location.

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

> [!NOTE]
> **GitHub Copilot provider is in public preview.** A warning is shown each time it is used. Some features work differently — see the table below.

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

### Provider Differences

| Feature                        | Claude Code                             | GitHub Copilot                                                          |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------- |
| Status                         | ✅ GA                                   | ⚠️ Public preview                                                       |
| Headless execution             | ✅ `-p --output-format json`            | ✅ `-p -s --autopilot --no-ask-user`                                    |
| Session IDs                    | ✅ In JSON output (`session_id`)        | ✅ Captured via `--share` output file                                   |
| Session resume (`--resume`)    | ✅ Full support                         | ✅ Supported when session ID is available                               |
| Per-tool permissions           | ✅ Settings files + `--permission-mode` | ⚠️ `--allow-all-tools` (all-or-nothing by default)                      |
| Fine-grained tool control      | ✅ `allow`/`deny` in settings files     | ✅ `--allow-tool`, `--deny-tool` flags (not yet used)                   |
| Pre-flight permission warnings | ✅ Reads settings files                 | — No-op (all tools already granted)                                     |
| Rate limit detection           | ✅ Validated patterns                   | ⚠️ Borrowed from Claude — not yet validated against real Copilot errors |

### Requirements

- **Claude Code:** Install the `claude` CLI and authenticate ([docs](https://docs.anthropic.com/en/docs/claude-code))
- **GitHub Copilot:** Install the `copilot` CLI and authenticate ([docs](https://docs.github.com/en/copilot/github-copilot-in-the-cli))

Both CLIs must be in your PATH.

---

## CLI Overview

| Command                  | Description                        |
| ------------------------ | ---------------------------------- |
| `ralphctl`               | Interactive menu mode              |
| `ralphctl config show`   | Show current configuration         |
| `ralphctl config set`    | Set configuration values           |
| `ralphctl project add`   | Register a project and its repos   |
| `ralphctl sprint create` | Create a new sprint                |
| `ralphctl ticket add`    | Add a work item to a sprint        |
| `ralphctl sprint refine` | Refine requirements with AI        |
| `ralphctl sprint plan`   | Generate tasks from requirements   |
| `ralphctl sprint ideate` | Quick single-session refine + plan |
| `ralphctl sprint start`  | Execute tasks with AI              |
| `ralphctl sprint health` | Diagnose blockers and stale tasks  |
| `ralphctl sprint close`  | Close an active sprint             |
| `ralphctl task list`     | List tasks in the current sprint   |
| `ralphctl task next`     | Show the next unblocked task       |

Run `ralphctl <command> --help` for details on any command.

---

## Documentation

| Document                                          | Description                                       |
| ------------------------------------------------- | ------------------------------------------------- |
| [REQUIREMENTS.md](./.claude/docs/REQUIREMENTS.md) | Feature rationale and design decisions            |
| [ARCHITECTURE.md](./.claude/docs/ARCHITECTURE.md) | Technical architecture, data models, service APIs |
| [CLAUDE.md](./CLAUDE.md)                          | Developer guide and Claude Code project config    |
| [CONTRIBUTING.md](./CONTRIBUTING.md)              | How to contribute                                 |
| [CHANGELOG.md](./CHANGELOG.md)                    | Version history                                   |

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

To report a vulnerability, use [GitHub's private reporting](https://github.com/lukas-grigis/ralphctl/security/advisories/new). See [SECURITY.md](./SECURITY.md) for details.

---

## License

MIT — see [LICENSE](./LICENSE) for details.
