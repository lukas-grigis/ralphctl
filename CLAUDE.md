# RalphCTL — Agent Harness for AI Coding Tasks

Node.js 24 + TypeScript + Ink TUI. Three AI provider backends (Claude Code / GitHub Copilot / OpenAI Codex).
The TUI is the primary surface; the CLI exposes inspection + one-shot operations only.

Version is read from `package.json` via JSON import attribute in `src/business/version/cli-metadata.ts`.
Both `commander.version()` and the npm-update poll consume the same constant — bin and registry cannot drift.

**Read on demand** (not auto-imported — open with the `Read` tool when relevant):

- `.claude/docs/ARCHITECTURE.md` — module layout, ports, repository interfaces, data models, error tables
- `.claude/docs/KERNEL-DESIGN.md` — chain framework reference (`element` / `leaf` / `sequential` / `loop` / `guard`)
- `.claude/docs/REQUIREMENTS.md` — acceptance-criteria checklist
- `.claude/docs/DESIGN-SYSTEM.md` — TUI tokens, components, copy rules
- `.claude/docs/MANUAL-TEST-PLAYBOOK.md` — manual smoke-test script
- `.claude/docs/diagrams/` — Mermaid diagrams: module layout, chain framework, flow lifecycle, sprint / task state machines

## Build & Run

```bash
pnpm install
pnpm dev <command>     # tsx, no build needed
pnpm dev               # bare → Ink TUI (primary surface)
pnpm build             # tsup + tsx scripts/build-assets.ts → dist/cli.mjs + dist/{prompts,skills,manifest.json}
pnpm typecheck         # tsc --noEmit
pnpm lint              # ESLint
pnpm test              # vitest
pnpm format:check      # prettier
pnpm deadcode          # knip (clean tree exits 0)
pnpm gen:flow <name>   # scaffold a new flow (manifest + stub + tests)
```

Before every commit, run `/verify` (wraps `pnpm typecheck && pnpm lint && pnpm test`). All three must pass.
Pre-commit hook runs `lint-staged` (ESLint + Prettier on staged files); `pnpm lint:fix` / `pnpm format` patch.

Requirements: Node.js 24+ (managed via `mise.toml`), pnpm 10+, one of the supported AI CLIs in PATH and
authenticated.

## Architecture

**Four-module Clean Architecture** under `src/`: `domain → business → integration → application`. Inner
layers cannot import outer layers; `domain` and `business` cannot import I/O-bearing `node:*` modules. Pure
`node:*` (`node:path`, `node:url`, `node:util`, …) is allowed. ESLint `no-restricted-imports` in
`eslint.config.ts` enforces every direction.

**Function-first.** Use cases are factory functions returning `{ execute(input) }`. No `class` outside
`src/domain/value/error/`. No `this`. The ESLint config asserts this.

**Per-aggregate repositories.** `ProjectRepository`, `SprintRepository`, `SprintExecutionRepository`,
`TaskRepository`, `SettingsRepository` live under `src/domain/repository/<aggregate>/`. Business code consumes
**slim sub-ports** from `domain/repository/_base/` (`FindById`, `Save`, `Remove`); the composition root wires
the composite as the slim port. Importing composite `*Repository` types from business code is fenced.

**Sprint splits into three on-disk files** at `<dataRoot>/sprints/<sprint-id>/`: `sprint.json` (planning),
`execution.json` (branch / PR URL / setup audit), `tasks.json` (task list). Planning mutations don't collide
with execution-time writes.

**Chain primitives** in `src/application/chain/`: `element` (interface), `leaf`, `sequential`, `loop`,
`guard` (factory functions). **No `retry` or `onError`** — retry-on-429 is an adapter concern
(`IterationConfig.rateLimitRetries`); branching belongs inside a use case or a `guard`. `leaf(name, config,
{ label? })` — optional display label forwarded to `Element` and every `TraceEntry`; TUI rail renders it
when present; `name` stays the canonical identifier for dedupe and trace correlation.

**Flow registry** in `src/application/registry.ts` — every user-launchable flow declared as a `FlowManifest`
with `triggers` (pre-launch predicates). CLI command builder, TUI menu, and launcher consume from this one
array. Add a flow = append one entry. Use `pnpm gen:flow <name>` to scaffold.

**Composition root is `wire()`** at `src/application/bootstrap/wire.ts` — pure, returns `AppDeps`. Tests build
from a tmpdir via `storagePathsFromRoot(tmpDir)`; production resolves real paths via `resolveStoragePaths()`.
Each flow declares a slim `<Flow>Deps` subset of `AppDeps`.

**EventBus** (`business/observability/event-bus.ts`, impl `integration/observability/in-memory-event-bus.ts`)
is the fan-out for chain progress (`ChainStarted`, `ChainStep{Started,Completed,Failed}`,
`Chain{Completed,Failed,Aborted}`, `TaskAttempt{Started,Evaluated}`, `TaskRoundStarted`,
`FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShow/Clear`, `LogEvent`).
TUI panels subscribe live; `<sprintDir>/chain.log` sink subscribes for durable post-hoc trace. **One bus per
`wire()` call** — production / test bus state cannot cross-talk.

**Logger publishes to the same bus.** `createEventBusLogger({ eventBus, clock })` is the only Logger factory;
every `logger.info(...)` emits a `LogEvent`.

**Session scoping via `AsyncLocalStorage`** (`src/application/session/session.ts`). The runner wraps every
`element.execute()` in `runWithSession(id, …)` so deep adapters can read `currentSessionId()` and tag logs /
signals without explicit threading.

**Sibling-isolation** in `integration/ai/<concept>/` — each per-tool / per-variant adapter directory
(`providers/{claude,copilot,codex}/`, `signals/<variant>/`, `prompts/<flow>/`, `readiness/<tool>/`,
`skills/<source>/`) is independent. Cross-sibling access goes through `_engine/`. Port-shaped interfaces
(`*Port`, `*Adapter`, `*Provider`, `*Sink`, `*Loader`, `*Probe`, …) MUST live in `_engine/`.

**Ink TUI** at `src/application/ui/tui/`. Bare `ralphctl` mounts via `runtime/mount.tsx` — alt-screen
takeover (vim/htop-style), restored on every exit path. Non-TTY / `CI=1` / `RALPHCTL_NO_TUI=1` skip the
mount. `theme/tokens.ts` is the single source of visual truth — no inline hex / glyph / spacing.
`glyphFor(signalKind)` adds shape-redundancy under `NO_COLOR=1`. List renders sliced before `.map()`;
spinner state lives in the leaf `<Spinner />` so 90 ms timer re-renders don't propagate. See DESIGN-SYSTEM.md.

**CLI** at `src/application/ui/cli/`. Interactive flows (`refine` / `plan` / `ideate` / `implement` /
`readiness` / `create-sprint`) stay TUI-only by design. The CLI exposes `doctor`, `completion`,
`export-{context,requirements}`, `create-pr`, `settings`, `project`, `sprint`, `ticket`, `task`,
`runs` (`list` / `prune`), `snapshot` — inspection + one-shot operations.

## Implementation Style

**Result types** — every business operation returns `Result<T, DomainError>`. Import from
`@src/domain/result.ts` (the canonical re-export point); the underlying `typescript-result` library may only
be imported by that one file. ESLint enforces. Throws are reserved for programmer errors (ctx-shape
violations inside leaf projections).

**No barrel files anywhere under `src/`** — `export *` is banned. Every import names what it pulls in. ESLint
fences this.

**`@public` JSDoc tag whitelist** — symbols intentionally exported after dead-code cleanup are tagged
`@public` in JSDoc; `knip.json` whitelists them. `pnpm deadcode` exits 0 on a clean tree.

**Output types are success-side, not Result envelopes.** Use `Result<FooOutput, FooError>` in the function
signature, not `type FooOutput = Result<…>`.

**No hardcoded provider logic outside `src/integration/ai/providers/<tool>/`** — call through
`HeadlessAiProvider` / `InteractiveAiProvider` from `providers/_engine/`.

**No `@inquirer/prompts` imports** — call through the injected `PromptPort` (`InkPromptAdapter` is the only
implementation).

**No direct use-case calls from CLI commands or TUI views** — use flow factories from
`src/application/flows/<flow>/` and the `createRunner` chain runner. ESLint blocks the shortcut.

**Prompt templates** live under `src/integration/ai/prompts/<flow>/template.md` plus partials in `_partials/`.
Each template ships a branded `Prompt` type + parameter schema; regressions surface at typecheck.

- `{{VARIABLE}}` placeholders may be empty — avoid numbered lists that gap on empty substitution.
- Em-dash (`—`) not hyphen for explanatory clauses.
- No hardcoded package-manager commands (`pnpm`/`npm`/`pip`/`cargo`/`go test`) outside `{{PROJECT_TOOLING}}`
  or `{{CHECK_GATE_EXAMPLE}}`. Downstream ecosystems differ.
- Reference `.claude/` directories as "when present" — many downstream repos lack one.
- `never`/`always` rules name their exception inline.

## Workflows & State

Sprint lifecycle: `draft → active → review → done`.

| Operation               | Draft | Active | Review | Done |
| ----------------------- | :---: | :----: | :----: | :--: |
| Add / refine ticket     |   ✓   |   ✗    |   ✗    |  ✗   |
| Plan tasks              |   ✓   |   ✗    |   ✗    |  ✗   |
| Implement               |  ✓\*  |   ✓    |   ✗    |  ✗   |
| Review (apply feedback) |   ✗   |   ✗    |   ✓    |  ✗   |
| Close (review → done)   |   ✗   |   ✗    |   ✓    |  ✗   |

\*`implement` auto-activates a draft sprint that has tasks. Implement transitions the sprint to `review` once
every task is `done`. The `sprint close` CLI command and the close-sprint flow accept only `review`-status.

**Two-phase planning.** **Refine** (`refine` chain) is implementation-agnostic per-ticket clarification —
no repo exploration; ticket `requirementStatus` flips `pending → approved`. **Plan** (`plan` chain) requires
every ticket `approved`; repo selection runs inside the chain and persists on `Sprint.affectedRepositories`
(absolute paths); AI generates `tasks.json` atomically. **Ideate** combines both in a single AI session for
low-stakes work.

**Per-task generator-evaluator** inside `implement` uses the `loop` primitive. Body is
`generator-leaf → evaluator-leaf → settle-attempt-leaf`. Exits when the evaluator passes or `maxAttempts`
fires (the task then transitions to `blocked`). Per-flow model from `settings.ai.models.implement`.

**TUI is the primary surface.** From Home: pipeline-map quick-actions + browse submenu (Sprints / Tickets /
Tasks / Projects). Multi-flow navigation: Tab / Shift+Tab cycle running flows, `Ctrl+1..9` direct-jump,
`SessionsView` lists every runner. `?` opens the centralised help overlay generated from `keyboard-map.ts`.

Execute view: three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail at `md` (100–139),
single-column below `md`. Rail grows fluidly 28→40 cols at `xl`+ via `resolveRailWidth`. Named breakpoints
(`sm 80 / md 100 / lg 140 / xl 180 / xxl 220`) are canonical — use `breakpointFor`, `fluid`, `responsive`,
`useBreakpoint` from `theme/tokens.ts`; no hardcoded column literals. Global keys: `b` banner, `g` progress,
`y` yank, `P` project picker, `S` sprint picker. Execute-view: `j`/`k` nav, `e` done-criteria, `c` cancel-scope.

**`setupScript` vs `checkScript`.** Setup runs unconditionally once per affected repo at sprint start;
each attempt is recorded as a structured `SetupRun` (outcome: `success` / `failed` / `spawn-error` /
`skipped`) persisted on `SprintExecution.setupRanAt`. Non-zero exit or spawn failure hard-aborts the
chain. Check runs both **pre-task** (before the AI) and **post-task** (after commit) with an attribution
algorithm (`clean` / `regressed` / `baseline-broken` / `fixed-baseline`) that avoids blocking the AI for
pre-existing failures. Failure transitions the task to `blocked`, never `done`. Both scripts are collected
during `detect-scripts` and persisted on `Repository.{setupScript,checkScript}`.

**Branch management.** `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
per-task preflight verifies the right branch. `ralphctl create-pr --sprint <id>` opens PR / MR via `gh` /
`glab` and persists `SprintExecution.pullRequestUrl`.

## Security & Safety

**Provider permission model is per-tool, not portable.** Don't assume Claude / Copilot / Codex share gates.

| Provider         | Headless permission flag              | Native context file               |
| ---------------- | ------------------------------------- | --------------------------------- |
| `claude-code`    | `--permission-mode bypassPermissions` | `CLAUDE.md` at repo root          |
| `github-copilot` | `--allow-all-tools`                   | `.github/copilot-instructions.md` |
| `openai-codex`   | per-session approval flow             | `AGENTS.md`                       |

The `readiness` flow writes the native file selected by `settings.ai.provider` — no symlinks, no pointer
schemes. Don't introduce either.

**Cross-process advisory lock** at `<stateRoot>/locks/sprints/<sprint-id>.lock` prevents two ralphctl
processes racing the same sprint. Stale-takeover via `RALPHCTL_LOCK_TIMEOUT_MS` (default 30s, range
1–3600000).

**Atomic file writes** via `business/io/write-file.ts` for all persisted state. Direct `fs.writeFile` is
fenced from business code by the layer rules.

**`AbortError` is the one error chains propagate transparently.** User-initiated cancellation (Ctrl+C, the
TUI abort hotkey) flows through every wrapper without being absorbed by guards or fallbacks. Anywhere a guard
or fallback catches errors, it MUST exempt `AbortError`.

**AI sessions plug onto the repo (implement / ideate).** Cwd is the user's repo (multi-repo flows
pick `repositories[0]`); the per-flow sandbox under `<sprintDir>/<flow>/<unit-slug>/` is mounted via
`--add-dir` so `prompt.md`, `done-criteria.md`, and `signals.json` round-trip through harness-controlled
paths. Cwd is the repo because Claude / Copilot / Codex only auto-discover their context file
(`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`), skills (`.claude/skills/` /
`.github/skills/` / `.agents/skills/`), agents, and `.mcp.json` from cwd — not from `--add-dir` roots.
Harness-authored skills land in `<repo>/<parentDir>/skills/ralphctl-*/` and the skills adapter appends one
wildcard line to `.git/info/exclude` on first install so they never appear in `git status` or `git add -A`.

**Refine and plan are the exceptions — their AI sessions run in the per-sprint unit root.**
Refine's session is rooted at `<sprintDir>/refinement/<ticket-slug>/`; plan's at
`<sprintDir>/plan/<run-slug>/`. Rooting either in any one repo would auto-load that repo's `CLAUDE.md` /
agents / `.mcp.json` and bias the AI toward implementation specifics (refine) or toward repositories[0]
on a multi-repo project (plan); refine would also pollute the repo with bundled skills. Plan mounts
**every** project repository as an equal `--add-dir` source — no repo enjoys cwd privilege, so the planner
treats every repo symmetrically. Refine's repo path is still consulted at launch time to derive
`defaultIssueOrigin` for the "update remote" reviewer option, but no AI session is rooted there.

**Bundled skills always lose to project skills.** When `<cwd>/.claude/skills/<name>/` already exists, the
bundled copy is skipped and the project copy is left untouched. The skills adapter
(`src/integration/ai/skills/adapter-factory.ts`) tracks only what it installed; uninstall removes only
those entries.

**File-based AI provider contract** — providers write `signals.json` and a `sessionId` file per spawn
(both persisted to `<sprintDir>/implement/<unit-slug>/rounds/<N>/<role>/`); the harness reads them
post-spawn. No stdout parsing for signals or session IDs. Replaces a long-standing brittleness vector
when CLI vendors tweak JSON shape.

## Performance & Limits

**Implement is strictly sequential.** Tasks run one at a time in topological order over `Task.blockedBy`,
linearised via `topologicalReorder` (Kahn's). `settings.concurrency.maxParallelTasks` is wired but only `1`
is supported in 0.7.0; concurrent fan-out needs a new chain primitive (deferred).

**Rate-limit retry is adapter-side.** The headless provider wrapper at
`src/integration/ai/providers/_engine/rate-limit-backoff.ts` sleeps with exponential delay between 429
retries. Per-spawn cap is `settings.harness.rateLimitRetries` (range 0–10). Coordinator pause / resume
events bridge to the EventBus; the TUI's `StatusBanner` (tiered `info` / `warn` / `error`) replaces the
old single-purpose `RateLimitBanner`.

**Idle-stdout watchdog** kills wedged headless AI children past a configurable idle threshold. A stuck Claude
/ Copilot / Codex process cannot strand the harness.

**Resume of aborted Implement runs.** Tasks left in `in_progress` from a prior crash reset to `todo` on next
launch and re-enter the queue. No double-execution.

**Iteration budget.** `settings.harness` carries:

- `maxTurns` (1–10) — generator-evaluator turns budgeted per attempt
- `maxAttempts` (1–10) — cap on attempts per task before transitioning to `blocked`
- `rateLimitRetries` (0–10) — adapter-side 429 retries
- `plateauThreshold` (2–5, default 2) — consecutive evaluator rounds flagging the same failed-dimension
  set before the loop exits with a plateau warning; score improvement, commit-progress, or
  critique-Jaccard shift can exempt a round from counting

Mirrored on `IterationConfig` (`src/application/chain/run/iteration-config.ts`); the chain `loop` predicates
and the headless provider adapter read it.

**Trace ring buffer.** The runner caps `runner.trace` at `MAX_TRACE_ENTRIES = 5_000`
(`src/application/ui/tui/views/execute-view.tsx`). The `TaskRoundStarted` event (carrying `roundN`,
`attemptN`, `totalCap`) drives the `round N/M` display — replacing the old React-ref high-water mark.

**Persistent `<sprintDir>/chain.log`** — every implement-style run appends its full trace, bracketed by
`=== chain-run <id> <flowId> started <iso> ===` / `… completed/failed/aborted …` delimiters. `tail -f`-friendly.

**`progress.md` is snapshot-rendered**, not streaming. `renderProgressMarkdown(state)` regenerates from
the `SprintState` projection at sprint start, after every `settle-attempt-leaf`, and on status transitions.
The old `progress-file-sink` is removed.

**Per-round artifacts.** Generator and evaluator prompts land at `rounds/<N>/{generator,evaluator}/prompt.md`
before each spawn; `settle-attempt-leaf` writes `rounds/<N>/outcome.md` after settlement.

**`<sprintDir>/decisions.log`** captures AI-emitted `<decision>` tags; merged into `progress.md §
Decisions`. `settings.ui.notifications.enabled` (default `true`) gates terminal bell + macOS `osascript`.

**Environment variables.**

| Variable                     | Default        | Range / values                         | Purpose                                                       |
| ---------------------------- | -------------- | -------------------------------------- | ------------------------------------------------------------- |
| `RALPHCTL_HOME`              | `~/.ralphctl/` | absolute path                          | Override application root (data + config + state)             |
| `RALPHCTL_LOCK_TIMEOUT_MS`   | 30000          | 1–3600000                              | Stale lock file threshold for concurrent-access detection     |
| `RALPHCTL_SKIP_LEGACY_CHECK` | unset          | any truthy value                       | Bypass the v0.6.x legacy-layout detector at boot              |
| `RALPHCTL_LOG_LEVEL`         | `info`         | `silent`/`debug`/`info`/`warn`/`error` | Filter structured-log output (console + bus subscribers)      |
| `RALPHCTL_NO_TUI`            | unset          | any truthy value                       | Force the plain-text CLI fallback even on a TTY               |
| `RALPHCTL_JSON`              | unset          | any truthy value                       | Force JSON log output (one object per line) regardless of TTY |
| `NO_COLOR`                   | unset          | any truthy value                       | Suppress ANSI colors                                          |
| `CI`                         | auto-detected  | any truthy value                       | Disables Ink mount and implicit interactive prompts           |

**Release procedure.** GitHub Actions auto-publishes on tags `v[0-9]+.[0-9]+.[0-9]+`. Tag must match
`package.json#version`; `CHANGELOG.md` needs a `## [X.Y.Z]` section (the literal-prefix extractor surfaces
it). NPM publish uses `--provenance`. Pre-releases are tags containing `-`.

**References** — [Anthropic — Effective Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Anthropic — Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Martin Fowler — Harness Engineering](https://martinfowler.com/articles/harness-engineering.html).
