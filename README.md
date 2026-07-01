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
  <img src="./.github/assets/home.png" alt="ralphctl home screen — Ralph donut banner with 'The pointy kitty took it!' tagline, WORK / OBSERVE / SYSTEM menus with keybindings, bottom footer" width="900" />
</p>

# ralphctl

**A ralph harness for long-running AI coding tasks — a hardened ralph loop that
orchestrates [Claude Code](https://docs.anthropic.com/en/docs/claude-code) across repositories,
with [GitHub Copilot](https://docs.github.com/en/copilot/github-copilot-in-the-cli) and
[OpenAI Codex](https://github.com/openai/codex) available in preview.**

> _"I'm helping!"_ — Ralph Wiggum

> [!NOTE]
> **Active development.** New features and polish ship regularly. The latest release expands the preset
> matrix to 20 presets across five families (`standard`, `economic`, `strong-gate`, `fast`, `frontier`),
> each in `mixed` / `claude-only` / `copilot-only` / `codex-only` variants.
> Upgrades are best-effort: install the latest version, redo your config, proceed.
> See [Upgrading](#upgrading) and [CHANGELOG](./CHANGELOG.md).

---

## What is a ralph harness?

The "Ralph" technique comes from Geoffrey Huntley's [Ralph Wiggum as a software engineer](https://ghuntley.com/ralph/):
point a coding agent at a task and run it in a loop until the work is done. The bare version
(`while :; do cat PROMPT.md | claude-code; done`) loops blindly — it re-runs the same prompt and hopes each pass lands.
ralphctl is a ralph harness around that idea: instead of blind repetition it runs a generator-evaluator loop, where one
pass writes the change and a second independent pass reviews it against the task spec before the loop advances. Same
loop, with a verification gate on every step.

---

## What is ralphctl?

AI coding agents are powerful but lose context on long tasks, need babysitting when things break, and have no way to
coordinate changes across multiple repositories. ralphctl wraps your chosen AI CLI — Claude Code, with GitHub Copilot
and OpenAI Codex in preview — in a
structured harness that decomposes your work into dependency-ordered tasks, drives each one through
a [generator-evaluator loop](https://www.anthropic.com/engineering/harness-design-long-running-apps) that catches issues
before moving on, and persists context across sessions so nothing gets lost.

You describe what to build. ralphctl handles the rest — or works alongside you, whichever you prefer.

---

## Quick Start

```bash
npm install -g ralphctl
```

> Needs [Node.js](https://nodejs.org/) ≥ 24 — `mise use node@24` or `nvm install 24`.

Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (or a preview provider — see below) and
authenticate it, then confirm ralphctl can see it:

```bash
ralphctl doctor    # verifies your provider CLI is installed + authenticated — the #1 first-run failure
```

When `doctor` is green, launch:

```bash
ralphctl
```

That's it. The TUI launches, walks you through registering a project, refining your first ticket, generating a task
plan, and kicking off implementation. Press `+` from the home screen to create a new sprint, press `n` to start a
flow (refine / plan / implement / readiness / …), or open the Sprints submenu and follow its on-screen hint to pick
or create a sprint. No commands to memorize.

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
ralphctl settings apply-preset claude-only     # or mixed / copilot-only / codex-only / *-economic / *-strong-gate / *-fast / *-frontier
ralphctl settings set ai.implement.generator.provider claude-code
ralphctl settings set ai.implement.generator.model    <model-id>
ralphctl settings set ai.implement.generator.effort   high
ralphctl settings set ai.implement.evaluator.provider openai-codex
ralphctl settings set ai.implement.evaluator.model    <model-id>
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
dependency-ordered task graph. **Implement** drives those tasks in dependency order through a generator-evaluator cycle:
a second AI pass reviews each task against its spec before the harness marks it done and moves on. Independent tasks in
the same dependency wave can run in parallel (opt-in) when you want a sprint to finish faster.

Key properties:

- **Dependency-ordered execution** — tasks run in topological order; no task starts until its blockers are done.
  Opt-in parallelism (`concurrency.maxParallelTasks` > 1) runs independent tasks within a dependency wave concurrently,
  each in its own git worktree folded onto one branch — default stays serial
- **Generator-evaluator cycle** — an independent AI reviewer checks each task; if it fails, the generator gets the
  critique and iterates (up to `harness.maxAttempts` tries before the task is flagged `blocked`)
- **Context persistence** — sprint state, branch, progress history, and per-task context survive across sessions;
  interrupted runs resume automatically
- **Multi-repo support** — one sprint can span several repositories with per-repo setup and verify scripts

For the full architectural picture see [`.claude/docs/ARCHITECTURE.md`](./.claude/docs/ARCHITECTURE.md) and [
`.claude/docs/REQUIREMENTS.md`](./.claude/docs/REQUIREMENTS.md).

---

## Provider Status

> [!IMPORTANT]
> Not all three AI providers are equally production-ready inside ralphctl.

| Provider                                  | Status                                                                          | Headless flag                                               | Native context file               |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| **Claude Code** (`claude-code`)           | **Stable — primary verified provider**                                          | `--permission-mode bypassPermissions` + per-tool deny list  | `CLAUDE.md` at repo root          |
| **GitHub Copilot CLI** (`github-copilot`) | Preview — maturing; works well day-to-day, not yet formally verified end-to-end | `--autopilot --allow-all` + `--max-autopilot-continues=200` | `.github/copilot-instructions.md` |
| **OpenAI Codex** (`openai-codex`)         | Preview — maturing; works well day-to-day, not yet formally verified end-to-end | `-s workspace-write` (topology-scoped)                      | `AGENTS.md`                       |

"Preview" means the integration is in active use and increasingly solid — recent releases run Copilot and Codex well
across the everyday flows — but harness behaviour against them hasn't been put through the same formal end-to-end
verification as Claude Code. A couple of features still no-op on them (bundled skill injection, `bodyFile` forensic
artifacts), and Codex can't fine-grained-deny edits on existing repo files — its sandbox modes are binary, so path
scope (cwd + `--add-dir`) is the only safety envelope. Parallel execution is provider-agnostic: it works with whichever
provider each implement role is configured to use, under the same per-provider caveats. If you hit a rough edge on a
preview provider, please [open an issue](https://github.com/lukas-grigis/ralphctl/issues).

One-shot configuration for any provider: `ralphctl settings apply-preset <name>` where `<name>` is one of
20 presets across five families — `standard`, `economic`, `strong-gate`, `fast`, and `frontier`, each in
`mixed` / `claude-only` / `copilot-only` / `codex-only` variants.

---

## Features

- **Break big tickets into small tasks** — dependency-ordered so they execute in the right sequence
- **Catch mistakes before they compound** — independent AI review after each task, iterating until quality passes or
  budget is exhausted
- **Coordinate across repositories** — one sprint can span multiple repos with automatic dependency tracking
- **Finish sprints faster (opt-in)** — run independent tasks within a dependency wave in parallel, each in its own git
  worktree, folded back onto one sprint branch (still one PR); default stays serial, zero change
- **Branch per sprint** — optional shared branch across every affected repo; `ralphctl create-pr --sprint <id>` opens a
  PR / MR via `gh` or `glab` when you're done
- **Recover from rate limits** — exponential backoff and session resume keep the in-flight task's full context when the
  provider restarts
- **Separate the what from the how** — AI clarifies requirements first (Refine), then generates the implementation
  plan (Plan), with human approval gates between
- **Pick up where you left off** — full state persistence; interrupted Implement runs resume in-progress tasks
  first — the crashed attempt is settled as aborted (kept in history) and a fresh attempt opens automatically
- **Pair or let it run** — work alongside your AI agent interactively, or let it execute unattended
- **Zero-memorization start** — run `ralphctl` with no args for a guided menu

---

## Configuration

Configure via the TUI `Settings` view or one-shot CLI commands.

**Quickest path — apply a preset.** Presets auto-seed from your detected CLIs on first run; override later with
`apply-preset`.

<details>
<summary>All 20 presets across five families</summary>

```bash
# Standard — flagship model per flow
ralphctl settings apply-preset mixed               # best-fit provider per flow
ralphctl settings apply-preset claude-only         # every flow on Claude Code
ralphctl settings apply-preset copilot-only        # every flow on GitHub Copilot
ralphctl settings apply-preset codex-only          # every flow on OpenAI Codex

# Economic — implement starts one tier below flagship; escalation ladder climbs only on plateau
ralphctl settings apply-preset mixed-economic
ralphctl settings apply-preset claude-economic
ralphctl settings apply-preset copilot-economic
ralphctl settings apply-preset codex-economic

# Strong-gate — cheap generator, permanently-flagship evaluator gate
ralphctl settings apply-preset mixed-strong-gate
ralphctl settings apply-preset claude-strong-gate
ralphctl settings apply-preset copilot-strong-gate
ralphctl settings apply-preset codex-strong-gate

# Fast — cheapest viable tier at low effort; plateau settles rather than escalating (escalateOnPlateau=false)
ralphctl settings apply-preset mixed-fast
ralphctl settings apply-preset claude-fast
ralphctl settings apply-preset copilot-fast
ralphctl settings apply-preset codex-fast

# Frontier — flagship everywhere at max effort
ralphctl settings apply-preset mixed-frontier
ralphctl settings apply-preset claude-frontier
ralphctl settings apply-preset copilot-frontier
ralphctl settings apply-preset codex-frontier
```

Twenty presets across five families ship, all equally first-class — none is marked default. Applying a
preset stamps the entire `ai` section plus `harness.escalateOnPlateau` in one transaction (`fast` stamps it
`false` so a plateau settles; all others stamp it `true`). On a fresh install the welcome view silently
auto-seeds a preset based on which provider CLIs it detects on `PATH`.

</details>

**Per-flow settings.** Each flow carries its own `{provider, model, effort?}` row: `refine`, `plan`, `readiness`,
`ideate`, and `createPr`. The `implement` flow instead splits into a nested `generator` / `evaluator` pair
(`ai.implement.generator.*` and `ai.implement.evaluator.*`), each its own `{provider, model, effort?}` row. Edit
individual keys with:

```bash
ralphctl settings set ai.implement.generator.provider claude-code
ralphctl settings set ai.implement.generator.model    <model-id>
ralphctl settings set ai.implement.generator.effort   high

ralphctl settings set ai.plan.provider      github-copilot
ralphctl settings set ai.plan.model         <model-id>
```

The selected provider's CLI must be in your `PATH` and authenticated. Every AI-spawning flow probes its
row's CLI at launch and exits with a clear error if the binary is missing.

**Tune the generator-evaluator loop** (under `harness`):

```bash
ralphctl settings set harness.maxAttempts 2          # Cap fix attempts per task (1–10, default 3)
ralphctl settings set harness.maxTurns    8          # Generator-evaluator turns per attempt (1–10)
ralphctl settings set harness.rateLimitRetries 3     # Adapter-side 429 retries (0–10)
```

**Run tasks in parallel** (optional — default is serial):

```bash
ralphctl settings set concurrency.maxParallelTasks 3   # 1–5; 1 = serial (default), >1 = parallel git worktrees
```

When `> 1`, independent tasks within a dependency wave run concurrently — each in its own git worktree, with its own
`setupScript` run, folded back onto the single sprint branch (still one PR per sprint). A task whose worktree setup
fails is blocked on its own without stopping its siblings; if two same-wave tasks edit the same file, the second is
blocked at fold time and a relaunch retries it. Dependencies are always respected — only independent tasks overlap.

### Data directory

All state lives in `~/.ralphctl/` by default (settings under `config/`, sprints + projects under `data/`, advisory locks
under `state/`). Override the root with:

```bash
export RALPHCTL_HOME="/path/to/custom/dir"
```

### Environment variables

| Variable                     | Default        | Purpose                                              |
| ---------------------------- | -------------- | ---------------------------------------------------- |
| `RALPHCTL_HOME`              | `~/.ralphctl/` | Override application root (data + config + state)    |
| `RALPHCTL_SKIP_LEGACY_CHECK` | unset          | Bypass the v0.6.x legacy-layout detector at boot     |
| `RALPHCTL_NO_TUI`            | unset          | Suppress implicit interactive prompts in `implement` |
| `NO_COLOR`                   | unset          | Suppress ANSI colors                                 |
| `CI`                         | auto-detected  | Suppress implicit interactive prompts in `implement` |

Log verbosity is `settings.logging.level` (`silent` / `debug` / `info` / `warn` / `error`, default `info`), set via
`ralphctl settings set logging.level <level>` or the TUI `Settings` view — not an environment variable.

---

## Upgrading

Install the latest version, redo your config, proceed. Only the latest
release is supported — there's no backporting, and upgrading is the answer
to most "is this fixed?" questions.

```bash
npm install -g ralphctl@latest
ralphctl settings apply-preset <name>    # if your settings need a reset
ralphctl                                  # TUI prompts you to re-register projects if needed
```

If your `~/.ralphctl/` data from an older release doesn't load cleanly, back
it up and start fresh:

```bash
mv ~/.ralphctl ~/.ralphctl.bak
```

The backup keeps your ticket bodies, plan output, and progress notes around
for reference. See [MIGRATION.md](./MIGRATION.md) if you're crossing a major
boundary (e.g. 0.6.x → 0.7.x) and want the longer story.

---

<details>
<summary><strong>CLI Command Reference</strong></summary>

The CLI surface is deliberately smaller than v0.6.x — interactive flows (refine / plan / ideate / implement /
readiness / create sprint) stay TUI-only by design. The CLI exposes inspection + one-shot operations.

### Getting Started

| Command                                 | Description                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ralphctl`                              | Interactive TUI (primary surface)                                                                                                                                                                                              |
| `ralphctl doctor`                       | Check environment health                                                                                                                                                                                                       |
| `ralphctl settings show`                | Print current settings                                                                                                                                                                                                         |
| `ralphctl settings set <key> <value>`   | Set a single settings key                                                                                                                                                                                                      |
| `ralphctl settings apply-preset <name>` | Stamp the entire `ai` section — 20 presets across five families: `standard` / `economic` / `strong-gate` / `fast` / `frontier`, each in `mixed` / `*-only` / `*-economic` / `*-strong-gate` / `*-fast` / `*-frontier` variants |
| `ralphctl completion <shell>`           | Print shell tab-completion script                                                                                                                                                                                              |

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
| `ralphctl task unblock <id>`       | Reset a blocked task to `todo`            |

### Sprint Lifecycle

| Command                         | Description                     |
| ------------------------------- | ------------------------------- |
| `ralphctl sprint activate <id>` | Flip a draft sprint to `active` |
| `ralphctl sprint close <id>`    | Transition `review` → `done`    |
| `ralphctl sprint remove <id>`   | Delete a sprint permanently     |

### Export & PR

| Command                                                                    | Description                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ralphctl export-requirements [--sprint <id>] --output <path>`             | Render approved-ticket requirements to markdown                |
| `ralphctl export-context [--sprint <id>] [--project <id>] --output <path>` | Render harness context (sprint + project + tasks) to markdown  |
| `ralphctl create-pr --sprint <id> [--base <branch>] [--draft]`             | Open a PR/MR via `gh` or `glab`, persist the URL on the sprint |

### Maintenance

| Command                                                                                    | Description                                     |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `ralphctl runs list [--flow <name>]`                                                       | List per-run forensic artifacts grouped by flow |
| `ralphctl runs prune [--older-than 7d] [--keep-last <n>] [--flow <name>] [--dry-run] [-y]` | Delete per-run forensic artifacts               |

Run `ralphctl <command> --help` for flag-level detail.

</details>

---

## Documentation

| Resource                                         | Description                                              |
| ------------------------------------------------ | -------------------------------------------------------- |
| [Architecture](./ARCHITECTURE.md)                | Data models, harness loop, file storage, error reference |
| [Adding a provider](./docs/adding-a-provider.md) | Extension guide: wire a new AI CLI into the harness      |
| [Requirements](./.claude/docs/REQUIREMENTS.md)   | Acceptance criteria and feature checklist                |
| [Contributing](./CONTRIBUTING.md)                | Dev setup, code style, PR process                        |
| [Migration](./MIGRATION.md)                      | Per-version upgrade context for big version jumps        |
| [Changelog](./CHANGELOG.md)                      | Version history                                          |

**Blog posts:** [Building ralphctl](https://lukasgrigis.dev/blog/building-ralphctl) (
backstory) | [From task CLI to ralph harness](https://lukasgrigis.dev/blog/ralphctl-agent-harness/) (evaluator
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
