[![npm version](https://img.shields.io/npm/v/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![npm downloads](https://img.shields.io/npm/dm/ralphctl?style=flat&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/ralphctl)
[![CI](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml/badge.svg)](https://github.com/lukas-grigis/ralphctl/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat&logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5_24-5fa04e?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat&logo=git&logoColor=white)](./CONTRIBUTING.md)
[![Claude Code](https://img.shields.io/badge/Claude_Code-191919?style=flat&logo=anthropic&logoColor=white)](https://docs.anthropic.com/en/docs/claude-code)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-000?style=flat&logo=githubcopilot&logoColor=white)](https://docs.github.com/en/copilot/github-copilot-in-the-cli)

<p align="center">
  <img src="./.github/assets/home.png" alt="ralphctl home screen — Ralph donut banner, sprint pipeline, keybinding footer" width="900" />
</p>

**Agent harness for long-running AI coding tasks —
orchestrates [Claude Code](https://docs.anthropic.com/en/docs/claude-code) & [GitHub Copilot](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
across repositories.**

> _"I'm helping!"_ — Ralph Wiggum

> [!NOTE]
> **Active development** — new features and polish ship regularly. Setup is quick, so upgrading is low-friction. See
> [CHANGELOG](./CHANGELOG.md).

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

2. Install 0.7.0:

   ```bash
   npm install -g ralphctl@0.7.0
   ```

3. Launch the TUI and re-register your projects:

   ```bash
   ralphctl
   ```

4. (Optional) Re-create sprints by hand from the backup — `~/.ralphctl.0.6-backup/data/sprints/<id>/`
   still holds the original ticket bodies, plan output, and progress notes for reference.

### What changed

- **On-disk schema is incompatible.** Each sprint now spans three files —
  `sprint.json` (planning), `execution.json` (branch / PR / setup audit), `tasks.json`
  (the task list) — instead of the single 0.6.x `sprint.json`. The 0.6.x layout does not
  parse. 0.7.0 reuses `~/.ralphctl/` as the data directory; override with
  `RALPHCTL_HOME=<absolute-path>` if you need a separate location.
- **`settings.json` schema changed.** Per-flow model selection replaces the single global
  `model`; each chain (`refine`, `plan`, `implement`, `ideate`, `readiness`) picks its own.
  0.6.x settings files are rejected on read — re-run `ralphctl settings` to reconfigure.
- **CLI surface intentionally smaller.** These commands were removed in favour of the TUI:
  `sprint feedback / edit`, `ticket approve / edit`, `project repo add / remove`,
  all `task add / edit / edit-status / remove`, and `sessions list / attach / detach / kill`.
  If you scripted any of these, switch to the interactive TUI or to `ralphctl sprint show <id>`
  / the relevant flow command.
- **OpenAI Codex provider added** alongside Claude Code and GitHub Copilot — pick via
  `ralphctl settings`.

See [CHANGELOG.md](./CHANGELOG.md#070---2026-05-17) for the full list, including non-breaking
improvements (cross-project sprint lock, idle-stdout watchdog, resume-aborted runs, persistent
`<sprintDir>/chain.log`, exponential rate-limit backoff).

---

## Why ralphctl?

AI coding agents are powerful but lose context on long tasks, need babysitting when things break, and have no way to
coordinate changes across multiple repositories. RalphCTL decomposes your work into dependency-ordered tasks, runs each
one through a [generator-evaluator loop](https://www.anthropic.com/engineering/harness-design-long-running-apps) that
catches issues before moving on, and persists context across sessions so nothing gets lost. You describe what to build —
ralphctl handles the rest.

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

- **Dependency-ordered execution** — tasks run strictly one at a time in topological order; the evaluator's read-only
  `git status` check catches dirty trees so work doesn't compound on a broken state
- **Generator-evaluator cycle** — an independent AI reviewer checks each task against its spec; if it fails, the
  generator gets feedback and iterates
- **Context persistence** — sprint state, progress history, and task context survive across sessions; interrupted work
  resumes where it left off

---

## Quick Start

```bash
npm install -g ralphctl
ralphctl
```

That's it. Launches the interactive TUI — walks you through project setup, ticket refinement, task planning, and
execution. No commands to memorize.

Requires [Node.js](https://nodejs.org/) >= 24, [Git](https://git-scm.com/), and one of the supported AI CLIs:
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[GitHub Copilot](https://docs.github.com/en/copilot/github-copilot-in-the-cli), or
[OpenAI Codex](https://github.com/openai/codex) — installed and authenticated.

<details>
<summary>Prefer the CLI for inspection + one-shot operations?</summary>

The interactive flows (refine / plan / ideate / implement / readiness / create sprint) are TUI-only. The CLI
covers inspection and one-shot operations:

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

## Features

- **Break big tickets into small tasks** — dependency-ordered so they execute in the right sequence
- **Catch mistakes before they compound** — independent AI review after each task, iterating until quality passes or
  budget is exhausted
- **Coordinate across repositories** — one sprint can span multiple repos with automatic dependency tracking
- **Branch per sprint** — optional shared branch across every affected repo; `ralphctl create-pr --sprint <id>`
  opens a PR / MR via `gh` or `glab` when you're done
- **Recover from rate limits** — automatic session resume across rate-limit pauses keeps the in-flight task's full
  context when the provider restarts
- **Separate the what from the how** — AI clarifies requirements first, then generates implementation tasks, with human
  approval gates
- **Pick up where you left off** — full state persistence across sessions; interrupted work resumes automatically
- **Pair or let it run** — work alongside your AI agent interactively, or let it execute unattended
- **Zero-memorization start** — run `ralphctl` with no args for a guided menu

---

## Configuration

RalphCTL supports **Claude Code**, **GitHub Copilot**, and **OpenAI Codex** as AI backends. Configure via the
TUI `Settings` view or one-shot CLI commands:

```bash
ralphctl settings set ai.provider claude-code         # Use Claude Code
ralphctl settings set ai.provider github-copilot      # Use GitHub Copilot
ralphctl settings set ai.provider openai-codex        # Use OpenAI Codex
```

The selected provider's CLI must be in your `PATH` and authenticated. The TUI prompts you on first launch if
no provider is configured.

**Per-flow model selection.** Each chain (`refine`, `plan`, `implement`, `ideate`, `readiness`) carries its
own model from the configured provider's catalog:

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

<details>
<summary>Provider differences</summary>

| Feature                     | Claude Code (`claude-code`)                         | GitHub Copilot (`github-copilot`)                  | OpenAI Codex (`openai-codex`)   |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------- | ------------------------------- |
| Headless permission mode    | `--permission-mode bypassPermissions`               | `--allow-all-tools`                                | provider-specific approval flow |
| Per-tool permissions        | `.claude/settings.local.json` allow/deny patterns   | `--allow-tool`, `--deny-tool` flags (not yet used) | approval flow per session       |
| Native context file         | `CLAUDE.md` at repo root                            | `.github/copilot-instructions.md`                  | `AGENTS.md`                     |
| Session ID source           | `signals.json` + `sessionId` file written per spawn | same                                               | same                            |
| Session resume (`--resume`) | full support                                        | full support                                       | full support                    |
| Rate-limit retry            | exponential backoff in the headless wrapper         | same wrapper, validated patterns                   | same wrapper                    |
| Bundled skill injection     | yes (`.claude/skills/<id>/SKILL.md`)                | no-op today                                        | no-op today                     |

</details>

---

## Data Directory

All data lives in `~/.ralphctl/` by default (settings under `config/`, sprints + projects under `data/`,
advisory locks under `state/`). Override with:

```bash
export RALPHCTL_HOME="/path/to/custom/app-dir"
```

The `RALPHCTL_HOME` env var, when set to an absolute path, replaces the entire `<home>/.ralphctl` prefix.
Upgrading from 0.6.x? Back up the existing `~/.ralphctl/` first — the 0.7.0 schema is incompatible.
See the upgrade section above.

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

**Blog posts:** [Building ralphctl](https://lukasgrigis.dev/blog/building-ralphctl) (backstory) | [From task CLI to agent harness](https://lukasgrigis.dev/blog/ralphctl-agent-harness/) (evaluator deep-dive)

**Further reading:** [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html) — Martin Fowler (April 2026) | [Harness Design for Long-Running Application Development](https://www.anthropic.com/engineering/harness-design-long-running-apps) — Anthropic Engineering

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
