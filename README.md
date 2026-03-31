[![npm version](https://img.shields.io/npm/v/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![npm downloads](https://img.shields.io/npm/dm/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![CI](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml/badge.svg)](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat&logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5_24-5fa04e?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4?style=flat&logo=prettier&logoColor=white)](https://prettier.io/)
[![ESLint](https://img.shields.io/badge/ESLint-4b32c3?style=flat&logo=eslint&logoColor=white)](https://eslint.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat&logo=git&logoColor=white)](./CONTRIBUTING.md)
[![Claude Code](https://img.shields.io/badge/Claude_Code-191919?style=flat&logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white)](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
[![Built with Donuts](https://img.shields.io/badge/%F0%9F%8D%A9-Built_with_Donuts-ff6f00?style=flat)](https://github.com/lukas-grigis/ralphctl)

```
  🍩 ██████╗  █████╗ ██╗     ██████╗ ██╗  ██╗ ██████╗████████╗██╗     🍩
     ██╔══██╗██╔══██╗██║     ██╔══██╗██║  ██║██╔════╝╚══██╔══╝██║
     ██████╔╝███████║██║     ██████╔╝███████║██║        ██║   ██║
     ██╔══██╗██╔══██║██║     ██╔═══╝ ██╔══██║██║        ██║   ██║
     ██║  ██║██║  ██║███████╗██║     ██║  ██║╚██████╗   ██║   ███████╗
     ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝
```

**Agent harness for long-running AI coding tasks — orchestrates [Claude Code](https://docs.anthropic.com/en/docs/claude-code) & [GitHub Copilot](https://docs.github.com/en/copilot/github-copilot-in-the-cli) across repositories.**

> _"I'm helping!"_ — Ralph Wiggum

> [!NOTE]
> **Early access.** RalphCTL is under active development. Things work, but expect rough edges and breaking changes
> before 1.0. Read the [blog post](https://lukasgrigis.dev/blog/building-ralphctl) for the backstory.

RalphCTL decomposes work into dependency-ordered tasks, executes them through AI coding agents, and runs a
[generator-evaluator loop](https://www.anthropic.com/engineering/harness-design-long-running-apps) to catch issues
before moving on. It manages context across sessions so nothing gets lost — whether you're working on a single ticket
or coordinating changes across multiple repositories. Ralph Wiggum personality included because why not.

---

## Install

```bash
npm install -g ralphctl
```

This installs the `ralphctl` command globally.

### Prerequisites

- [Node.js](https://nodejs.org/) **>= 24.0.0**
- [Git](https://git-scm.com/)
- Either [Claude CLI](https://docs.anthropic.com/en/docs/claude-code)
  or [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and authenticated

### 2-Minute Quick Start

```bash
# 1. Register a project (points to your repo)
ralphctl project add

# 2. Create a sprint
ralphctl sprint create --name "my-first-sprint"

# 3. Add a ticket
ralphctl ticket add --project my-app --title "Add user authentication"

# 4. Let AI refine requirements, plan tasks, and execute
ralphctl sprint refine
ralphctl sprint plan
ralphctl sprint start
```

Or just run `ralphctl` with no arguments for an interactive menu that walks you through everything.

---

## Table of Contents

- [Features](#features)
- [CLI Overview](#cli-overview)
- [AI Provider Configuration](#ai-provider-configuration)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Task decomposition** — breaks tickets into dependency-ordered tasks with topological sort
- **Generator-evaluator loop** — independent AI review after each task; iterates until quality passes or budget exhausted
- **Multi-repo orchestration** — coordinate changes across multiple repositories in a single run
- **Parallel execution** — one task per repo at a time, with automatic rate limit backoff and session resume
- **Two-phase planning** — clarify requirements first (what), then generate tasks (how), with a human approval gate
- **Context persistence** — state survives across sessions; interrupted work resumes where it left off
- **Interactive or headless** — pair with your AI agent in a session, or let it run unattended
- **Menu mode** — run `ralphctl` with no arguments for an interactive menu

---

## CLI Overview

### Getting Started

| Command                                          | Description                         |
| ------------------------------------------------ | ----------------------------------- |
| `ralphctl`                                       | Interactive menu mode (recommended) |
| `ralphctl doctor`                                | Check environment health            |
| `ralphctl config set provider <claude\|copilot>` | Set AI provider                     |
| `ralphctl config show`                           | Show current configuration          |
| `ralphctl completion install`                    | Enable shell tab-completion         |

### Project & Sprint Setup

| Command                  | Description                      |
| ------------------------ | -------------------------------- |
| `ralphctl project add`   | Register a project and its repos |
| `ralphctl sprint create` | Create a new sprint (draft)      |
| `ralphctl sprint list`   | List all sprints                 |
| `ralphctl sprint show`   | Show current sprint details      |
| `ralphctl sprint switch` | Quick sprint switcher            |
| `ralphctl ticket add`    | Add a work item to a sprint      |

### AI-Assisted Planning

| Command                        | Description                             |
| ------------------------------ | --------------------------------------- |
| `ralphctl sprint refine`       | Clarify requirements with AI (WHAT)     |
| `ralphctl sprint plan`         | Generate tasks from requirements (HOW)  |
| `ralphctl sprint ideate`       | Quick single-session refine + plan      |
| `ralphctl sprint requirements` | Export refined requirements to markdown |

### Execution & Monitoring

| Command                  | Description                       |
| ------------------------ | --------------------------------- |
| `ralphctl sprint start`  | Execute tasks with AI             |
| `ralphctl sprint health` | Diagnose blockers and stale tasks |
| `ralphctl dashboard`     | Sprint overview with progress bar |
| `ralphctl task list`     | List tasks in the current sprint  |
| `ralphctl task next`     | Show the next unblocked task      |
| `ralphctl sprint close`  | Close an active sprint            |
| `ralphctl sprint delete` | Delete a sprint permanently       |

Run `ralphctl <command> --help` for details on any command.

---

## AI Provider Configuration

RalphCTL supports **Claude Code** and **GitHub Copilot** as AI backends. Both use the same prompt templates and
workflow.

```bash
ralphctl config set provider claude      # Use Claude Code
ralphctl config set provider copilot     # Use GitHub Copilot
```

Auto-prompts on first AI command if not set. Both CLIs must be in your PATH and authenticated.

### Provider Differences

| Feature                     | Claude Code                          | GitHub Copilot                                                       |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| Status                      | GA                                   | Public preview                                                       |
| Headless execution          | `-p --output-format json`            | `-p --output-format json --autopilot --no-ask-user`                  |
| Session IDs                 | In JSON output (`session_id`)        | In JSON output (`session_id`), `--share` file as fallback            |
| Session resume (`--resume`) | Full support                         | Full support                                                         |
| Per-tool permissions        | Settings files + `--permission-mode` | `--allow-all-tools` (all-or-nothing by default)                      |
| Fine-grained tool control   | `allow`/`deny` in settings files     | `--allow-tool`, `--deny-tool` flags (not yet used)                   |
| Rate limit detection        | Validated patterns                   | Borrowed from Claude — not yet validated against real Copilot errors |

---

## Documentation

| Document                                                    | Description                                    |
| ----------------------------------------------------------- | ---------------------------------------------- |
| [REQUIREMENTS.md](./.claude/docs/REQUIREMENTS.md)           | Acceptance criteria and feature requirements   |
| [ARCHITECTURE.md](./.claude/docs/ARCHITECTURE.md)           | Data models, file storage, and error reference |
| [CLAUDE.md](./CLAUDE.md)                                    | Developer guide and Claude Code project config |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                        | How to contribute                              |
| [CHANGELOG.md](./CHANGELOG.md)                              | Version history                                |
| [Blog post](https://lukasgrigis.dev/blog/building-ralphctl) | Background and motivation                      |

---

## Data Directory

RalphCTL stores all data in `~/.ralphctl/` by default. Override with `RALPHCTL_ROOT`:

```bash
export RALPHCTL_ROOT="/path/to/custom/data-dir"
```

---

## Development

```bash
git clone https://github.com/lukas-grigis/ralphctl.git
cd ralphctl
pnpm install
pnpm dev --help          # Run CLI in dev mode (tsx, no build needed)
pnpm build               # Compile for npm distribution (tsup)
pnpm typecheck           # Type check
pnpm test                # Run tests
pnpm lint                # Lint
```

---

## Contributing

Contributions are welcome! Please **open an issue first** to discuss what you'd like to change.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide — dev setup, code style, PR process, and releasing.

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md) code of conduct.

---

## Security

To report a vulnerability,
use [GitHub's private reporting](https://github.com/lukas-grigis/ralphctl/security/advisories/new).
See [SECURITY.md](./SECURITY.md) for details.

---

## License

MIT — see [LICENSE](./LICENSE) for details.
