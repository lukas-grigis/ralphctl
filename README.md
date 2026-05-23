[![npm version](https://img.shields.io/npm/v/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![npm downloads](https://img.shields.io/npm/dm/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![CI](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml/badge.svg)](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat&logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5_24-5fa04e?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat&logo=git&logoColor=white)](./CONTRIBUTING.md)
[![Claude Code](https://img.shields.io/badge/Claude_Code-stable-191919?style=flat&logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![OpenAI Codex](https://img.shields.io/badge/OpenAI_Codex-preview-412991?style=flat&logo=openai&logoColor=white)](https://github.com/openai/codex)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-preview-000?style=flat&logo=githubcopilot&logoColor=white)](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
[![Built with Donuts](https://img.shields.io/badge/%F0%9F%8D%A9-Built_with_Donuts-ff6f00?style=flat)](https://github.com/lukas-grigis/ralphctl)

<p align="center">
  <img src="./.github/assets/home.png" alt="ralphctl v0.7.0 home screen — Ralph donut banner with 'The pointy kitty took it!' tagline, demo project tile, WORK / OBSERVE / SYSTEM menus with keybindings, bottom footer" width="900" />
</p>

**Agent harness for long-running AI coding tasks —
orchestrates [Claude Code](https://docs.anthropic.com/en/docs/claude-code) across repositories,
with [GitHub Copilot](https://docs.github.com/en/copilot/github-copilot-in-the-cli) and
[OpenAI Codex](https://github.com/openai/codex) available in preview.**

> _"I'm helping!"_ — Ralph Wiggum

> [!NOTE]
> **Active development** — new features and polish ship regularly. Setup is quick, so upgrading is low-friction.
> See [CHANGELOG](./CHANGELOG.md).

---

## What is ralphctl?

AI coding agents are powerful but lose context on long tasks, need babysitting when things break, and have no way to
coordinate changes across multiple repositories. ralphctl wraps your chosen AI CLI — currently Claude Code — in a
structured harness that decomposes your work into dependency-ordered tasks, drives each one through
a [generator-evaluator loop](https://www.anthropic.com/engineering/harness-design-long-running-apps) that catches issues
before moving on, and persists context across sessions so nothing gets lost.

You describe what to build. ralphctl handles the rest — or works alongside you, whichever you prefer.

---

## Quick Start

```bash
npm install -g ralphctl
```

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (or a preview provider — see below), authenticate
it, then:

```bash
ralphctl
```

That's it. The TUI launches, walks you through registering a project, refining your first ticket, generating a task
plan, and kicking off implementation. Press `n` from the home screen to start a new sprint, or follow the
`press r to open Sprints` hint on your project tile. No commands to memorize.

**Requirements:** [Node.js](https://nodejs.org/) ≥ 24, [Git](https://git-scm.com/), and one supported AI CLI in `PATH`
and authenticated.

<details>
<summary>Prefer the CLI for inspection + one-shot operations?</summary>

Interactive flows (refine / plan / ideate / implement / readiness / create sprint) are TUI-only. The CLI covers
inspection and one-shot operations:

```bash
# Inspect projects + sprints
ralphctl project list
ralphctl sprint list
ralphctl sprint show <sprint-id>
ralphctl sprint progress <sprint-id>

# Add / inspect tickets
ralphctl ticket add
ralphctl ticket list

# Manage sprint state
ralphctl sprint activate <sprint-id>
ralphctl sprint close <sprint-id>           # review → done
ralphctl sprint remove <sprint-id>

# Open a PR for the sprint branch
ralphctl create-pr --sprint <sprint-id>

# Export sprint artifacts
ralphctl export-requirements --sprint <id> --output <path>
ralphctl export-context --sprint <id> --project <id> --output <path>

# Settings
ralphctl settings show
ralphctl settings set ai.provider claude-code
ralphctl settings set ai.models.implement <model-id>
```

</details>

---

## How It Works

```
  You describe what to build           ralphctl handles the rest
  ─────────────────────────           ─────────────────────────────────
  ┌──────────┐   ┌──────────┐        ┌────────┐   ┌──────┐   ┌───────────┐
  │  Create  │──>│   Add    │───────>│ Refine │──>│ Plan │──>│ Implement │
  │  Sprint  │   │ Tickets  │        │ (WHAT) │   │(HOW) │   │   Loop    │
  └──────────┘   └──────────┘        └────────┘   └──────┘   └───────────┘
                                          │            │             │
                                     AI clarifies  AI generates  AI implements
                                     requirements  task graph    + AI reviews
                                     with you      from specs    each task
```

**Refine** is implementation-agnostic: the AI clarifies requirements with you, ticket by ticket, and flips each one from
`pending` to `approved`. **Plan** requires every ticket approved — the AI explores the affected repos and generates a
dependency-ordered task graph. **Implement** drives those tasks one at a time through a generator-evaluator cycle: a
second AI pass reviews each task against its spec before the harness marks it done and moves to the next.

Key properties:

- **Dependency-ordered execution** — tasks run strictly one at a time in topological order; no task starts until its
  blockers are done
- **Generator-evaluator cycle** — an independent AI reviewer checks each task; if it fails, the generator gets the
  critique and iterates (up to `harness.maxAttempts` tries before the task is flagged `blocked`)
- **Context persistence** — sprint state, branch, progress history, and per-task context survive across sessions;
  interrupted runs resume automatically
- **Multi-repo support** — one sprint can span several repositories with per-repo setup and check scripts

For the full architectural picture see [`.claude/docs/ARCHITECTURE.md`](./.claude/docs/ARCHITECTURE.md) and [
`.claude/docs/REQUIREMENTS.md`](./.claude/docs/REQUIREMENTS.md).

---

## Provider Status

> [!IMPORTANT]
> Not all three AI providers are equally production-ready inside ralphctl.

| Provider                                  | Status                                  | Headless flag                                               | Native context file               |
| ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| **Claude Code** (`claude-code`)           | **Stable — primary verified provider**  | `--permission-mode bypassPermissions` + per-tool deny list  | `CLAUDE.md` at repo root          |
| **GitHub Copilot CLI** (`github-copilot`) | Preview — not officially verified by us | `--autopilot --allow-all` + `--max-autopilot-continues=200` | `.github/copilot-instructions.md` |
| **OpenAI Codex** (`openai-codex`)         | Preview — not officially verified by us | `-s workspace-write` (topology-scoped)                      | `AGENTS.md`                       |

"Preview" means the integration exists and the TUI lets you select it, but end-to-end harness behaviour against those
providers has not been formally verified. Copilot and Codex no-op some features (bundled skill injection, `bodyFile`
forensic artifacts). Codex cannot fine-grained-deny edits on existing repo files — its sandbox modes are binary, so
path scope (cwd + `--add-dir`) is the only safety envelope. If you hit a rough edge on a preview provider,
please [open an issue](https://github.com/lukas-grigis/ralphctl/issues).

---

## Features

- **Break big tickets into small tasks** — dependency-ordered so they execute in the right sequence
- **Catch mistakes before they compound** — independent AI review after each task, iterating until quality passes or
  budget is exhausted
- **Coordinate across repositories** — one sprint can span multiple repos with automatic dependency tracking
- **Branch per sprint** — optional shared branch across every affected repo; `ralphctl create-pr --sprint <id>` opens a
  PR / MR via `gh` or `glab` when you're done
- **Recover from rate limits** — exponential backoff and session resume keep the in-flight task's full context when the
  provider restarts
- **Separate the what from the how** — AI clarifies requirements first (Refine), then generates the implementation
  plan (Plan), with human approval gates between
- **Pick up where you left off** — full state persistence; interrupted Implement runs reset in-progress tasks and
  re-enter the queue on next launch
- **Pair or let it run** — work alongside your AI agent interactively, or let it execute unattended
- **Zero-memorization start** — run `ralphctl` with no args for a guided menu

---

## Configuration

Configure via the TUI `Settings` view or one-shot CLI commands:

```bash
ralphctl settings set ai.provider claude-code         # Use Claude Code (stable)
ralphctl settings set ai.provider github-copilot      # Use GitHub Copilot (preview)
ralphctl settings set ai.provider openai-codex        # Use OpenAI Codex (preview)
```

The selected provider's CLI must be in your `PATH` and authenticated. The TUI prompts you on first launch if no provider
is configured.

**Per-flow model selection.** Each chain (`refine`, `plan`, `implement`, `ideate`, `readiness`) carries its own model
from the configured provider's catalog:

```bash
ralphctl settings set ai.models.implement <model-id>
ralphctl settings set ai.models.plan      <model-id>
```

**Tune the generator-evaluator loop** (under `harness`):

```bash
ralphctl settings set harness.maxAttempts 2          # Cap fix attempts per task (1–10, default 1)
ralphctl settings set harness.maxTurns    8          # Generator-evaluator turns per attempt (1–10)
ralphctl settings set harness.rateLimitRetries 3     # Adapter-side 429 retries (0–10)
```

### Data directory

All state lives in `~/.ralphctl/` by default (settings under `config/`, sprints + projects under `data/`, advisory locks
under `state/`). Override the root with:

```bash
export RALPHCTL_HOME="/path/to/custom/dir"
```

### Environment variables

| Variable                     | Default        | Purpose                                                               |
| ---------------------------- | -------------- | --------------------------------------------------------------------- |
| `RALPHCTL_HOME`              | `~/.ralphctl/` | Override application root (data + config + state)                     |
| `RALPHCTL_LOCK_TIMEOUT_MS`   | `30000`        | Stale lock threshold for concurrent-access detection (1–3600000 ms)   |
| `RALPHCTL_SKIP_LEGACY_CHECK` | unset          | Bypass the v0.6.x legacy-layout detector at boot                      |
| `RALPHCTL_LOG_LEVEL`         | `info`         | Filter structured-log output (`silent`/`debug`/`info`/`warn`/`error`) |
| `RALPHCTL_NO_TUI`            | unset          | Force the plain-text CLI fallback even on a TTY                       |
| `RALPHCTL_JSON`              | unset          | Force JSON log output (one object per line) regardless of TTY         |
| `NO_COLOR`                   | unset          | Suppress ANSI colors                                                  |
| `CI`                         | auto-detected  | Disables Ink mount and implicit interactive prompts                   |

---

## Upgrading from 0.6.x to 0.7.0

> [!IMPORTANT]
> **0.7.0 is a structural rewrite.** Internal architecture, on-disk schema, and several CLI
> commands all changed. **There is no automatic migration from 0.6.x** — sprints, projects,
> and settings written by 0.6.x will not be read by 0.7.0, even though the data directory
> path is the same.
>
> If you launch 0.7.0 with v0.6.x data still in `~/.ralphctl/`, the harness detects the
> legacy layout, **refuses to start**, and prints the exact backup command you need to run.
> No data is touched. The steps below are what the safeguard will tell you.

### Before upgrading

1. **Back up your 0.6.x data**:

   ```bash
   mv ~/.ralphctl ~/.ralphctl.0.6-backup
   ```

2. Install ralphctl (the latest published version is `0.7.x` — pin only if you need a specific patch):

   ```bash
   npm install -g ralphctl
   ```

3. Launch the TUI and re-register your projects:

   ```bash
   ralphctl
   ```

4. (Optional) Re-create sprints by hand from the backup — `~/.ralphctl.0.6-backup/data/sprints/<id>/` still holds the
   original ticket bodies, plan output, and progress notes for reference.

### What changed

- **On-disk schema is incompatible.** Each sprint now spans three files — `sprint.json` (planning), `execution.json` (
  branch / PR / setup audit), `tasks.json` (the task list) — instead of the single 0.6.x `sprint.json`. Override the
  data root with `RALPHCTL_HOME=<absolute-path>` if you need a separate location.
- **`settings.json` schema changed.** Per-flow model selection replaces the single global `model`; each chain picks its
  own. 0.6.x settings files are rejected on read — re-run `ralphctl settings` to reconfigure.
- **CLI surface intentionally smaller.** These commands were removed in favour of the TUI: `sprint feedback / edit`,
  `ticket approve / edit`, `project repo add / remove`, all `task add / edit / edit-status / remove`, and
  `sessions list / attach / detach / kill`. Switch to the interactive TUI or to `ralphctl sprint show <id>` / the
  relevant flow command.
- **OpenAI Codex provider added** (preview) alongside Claude Code and GitHub Copilot — pick via `ralphctl settings`.

See [CHANGELOG.md](./CHANGELOG.md#070---2026-05-17) for the full list, including non-breaking improvements (
cross-project sprint lock, idle-stdout watchdog, resume-aborted runs, persistent `<sprintDir>/chain.log`, exponential
rate-limit backoff).

---

<details>
<summary><strong>CLI Command Reference</strong></summary>

The CLI surface is deliberately smaller than v0.6.x — interactive flows (refine / plan / ideate / implement /
readiness / create sprint) stay TUI-only by design. The CLI exposes inspection + one-shot operations.

### Getting Started

| Command                               | Description                       |
| ------------------------------------- | --------------------------------- |
| `ralphctl`                            | Interactive TUI (primary surface) |
| `ralphctl doctor`                     | Check environment health          |
| `ralphctl settings show`              | Print current settings            |
| `ralphctl settings set <key> <value>` | Set a single settings key         |
| `ralphctl completion <shell>`         | Print shell tab-completion script |

### Project & Sprint Inspection

| Command                            | Description                               |
| ---------------------------------- | ----------------------------------------- |
| `ralphctl project list`            | List registered projects                  |
| `ralphctl project show <id>`       | Show one project (incl. repositories)     |
| `ralphctl project remove <id>`     | Delete a project registration             |
| `ralphctl sprint list`             | List all sprints                          |
| `ralphctl sprint show <id>`        | Show one sprint (tickets, status, branch) |
| `ralphctl sprint progress <id>`    | Sprint progress with blocker diagnostics  |
| `ralphctl sprint set-current <id>` | Switch the current sprint pointer         |
| `ralphctl ticket add`              | Add a ticket to the current sprint        |
| `ralphctl ticket list / show <id>` | Inspect tickets                           |
| `ralphctl ticket remove <id>`      | Remove a ticket from a draft sprint       |
| `ralphctl task list / show <id>`   | Inspect tasks (planning generates them)   |

### Sprint Lifecycle

| Command                         | Description                     |
| ------------------------------- | ------------------------------- |
| `ralphctl sprint activate <id>` | Flip a draft sprint to `active` |
| `ralphctl sprint close <id>`    | Transition `review` → `done`    |
| `ralphctl sprint remove <id>`   | Delete a sprint permanently     |

### Export & PR

| Command                                                                | Description                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ralphctl export-requirements --sprint <id> --output <path>`           | Render approved-ticket requirements to markdown                |
| `ralphctl export-context --sprint <id> --project <id> --output <path>` | Render harness context (sprint + project + tasks) to markdown  |
| `ralphctl create-pr --sprint <id> [--base <branch>] [--draft]`         | Open a PR/MR via `gh` or `glab`, persist the URL on the sprint |

Run `ralphctl <command> --help` for flag-level detail.

</details>

---

## Documentation

| Resource                                       | Description                                |
| ---------------------------------------------- | ------------------------------------------ |
| [Architecture](./.claude/docs/ARCHITECTURE.md) | Data models, file storage, error reference |
| [Requirements](./.claude/docs/REQUIREMENTS.md) | Acceptance criteria and feature checklist  |
| [Contributing](./CONTRIBUTING.md)              | Dev setup, code style, PR process          |
| [Changelog](./CHANGELOG.md)                    | Version history                            |

**Blog posts:** [Building ralphctl](https://lukasgrigis.dev/blog/building-ralphctl) (
backstory) | [From task CLI to agent harness](https://lukasgrigis.dev/blog/ralphctl-agent-harness/) (evaluator
deep-dive)

**Further reading:
** [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html) — Martin
Fowler (April 2026) | [Harness Design for Long-Running Application Development](https://www.anthropic.com/engineering/harness-design-long-running-apps) —
Anthropic Engineering

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
