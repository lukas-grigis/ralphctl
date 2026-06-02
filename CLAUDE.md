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
- `.claude/docs/HARNESS-PRINCIPLES.md` — distilled harness research from Anthropic + Fowler, with per-principle ralphctl
  status tags
- `.claude/docs/diagrams/` — Mermaid sequence / data-flow diagrams: chain framework, flow lifecycle, sprint lifecycle,
  task lifecycle, AI-session data flow

## Build & Run

```bash
pnpm install
pnpm dev <command>     # tsx, no build needed
pnpm dev               # bare → Ink TUI (primary surface)
pnpm build             # tsup + tsx scripts/build-assets.ts → dist/cli.mjs + dist/{prompts,skills,manifest.json}
pnpm typecheck         # tsc --noEmit
pnpm lint              # ESLint
pnpm test              # vitest
pnpm coverage          # vitest run --coverage (ad-hoc threshold check; not in verify)
pnpm verify:coverage   # alias for pnpm coverage
pnpm format:check      # prettier
pnpm deadcode          # knip (clean tree exits 0)
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
array. Add a flow = append one entry.

**Composition root is `wire()`** at `src/application/bootstrap/wire.ts` — pure, returns `AppDeps`. Tests build
from a tmpdir via `storagePathsFromRoot(tmpDir)`; production resolves real paths via `resolveStoragePaths()`.
Each flow declares a slim `<Flow>Deps` subset of `AppDeps`.

**EventBus** (`business/observability/event-bus.ts`, impl `integration/observability/in-memory-event-bus.ts`)
is the fan-out for chain progress (`ChainStarted`, `ChainStep{Started,Completed,Failed}`,
`Chain{Completed,Failed,Aborted}`, `TaskAttempt{Started,Evaluated}`, `TaskRoundStarted`,
`FeedbackRoundApplied`, `TokenUsageEvent`, `BannerShow/Clear`, `LogEvent`).
TUI panels subscribe live; the `<sprintDir>/events.ndjson` sink — opt-in via `RALPHCTL_DEBUG_TRACE=1`, a
no-op factory otherwise — subscribes when enabled for a durable post-hoc trace. **One bus per `wire()` call**
— production / test bus state cannot cross-talk.

**Logger publishes to the same bus.** `createEventBusLogger({ eventBus, clock })` is the only Logger factory;
every `logger.info(...)` emits a `LogEvent`.

**Session scoping via `AsyncLocalStorage`** (`src/application/session/session.ts`). The runner wraps every
`element.execute()` in `runWithSession(id, …)` so deep adapters can read `currentSessionId()` and tag logs /
signals without explicit threading.

**Sibling-isolation** in `integration/ai/<concept>/` — each per-tool / per-variant adapter directory
(`providers/{claude,copilot,codex}/`, `prompts/<flow>/`, `readiness/<tool>/`, `skills/<source>/`,
`contract/_engine/signals/<kind>/`) is independent. Cross-sibling access goes through `_engine/`.
Port-shaped interfaces (`*Port`, `*Adapter`, `*Provider`, `*Sink`, `*Loader`, `*Probe`, …) MUST live
in `_engine/`.

**Ink TUI** at `src/application/ui/tui/`. Bare `ralphctl` mounts via `launchTui` (`ui/tui/launch.ts`),
which renders through `createInkHost` (`ui/shared/ink-host.ts`) with `alternateScreen: true` — alt-screen
takeover (vim/htop-style), restored on every exit path. The mount is unconditional; `CI` / `RALPHCTL_NO_TUI`
/ non-TTY do not skip it — they only gate implicit interactive prompting inside the implement flow.
`theme/tokens.ts` is the single source of visual truth — no inline hex / glyph / spacing.
`glyphFor(signalKind)` adds shape-redundancy under `NO_COLOR=1`. List renders sliced before `.map()`;
spinner state lives in the leaf `<Spinner />` so 90 ms timer re-renders don't propagate. See DESIGN-SYSTEM.md.

**CLI** at `src/application/ui/cli/`. Interactive flows (`refine` / `plan` / `ideate` / `implement` /
`readiness` / `create-sprint`) stay TUI-only by design. The CLI exposes `doctor`, `completion`,
`export-{context,requirements}`, `create-pr`, `settings`, `project`, `sprint`, `ticket`, `task`,
`runs` (`list` / `prune`) — inspection + one-shot operations.

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
- Every prompt directory has a `tests/integration/ai/prompts/<flow>/definition.test.ts` asserting
  placeholder ↔ parameter parity (both directions). The meta-test at `template-coverage.test.ts`
  fails the suite when a new flow lands without one.

## Workflows & State

Sprint lifecycle: `draft → planned → active → review → done`.

| Operation               | Draft | Planned | Active | Review | Done |
| ----------------------- | :---: | :-----: | :----: | :----: | :--: |
| Add / refine ticket     |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Plan tasks              |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Implement               |   ✗   |   ✓\*   |   ✓    |   ✗    |  ✗   |
| Review (apply feedback) |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |
| Close (review → done)   |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |

\*`plan` moves a draft sprint to `planned`; `implement` then activates it (`planned → active`) on first
launch, passing an already-`active` sprint through idempotently — a draft sprint must be planned first.
Implement transitions the sprint to `review` once every task has settled (`done` or `blocked`) AND at least
one task settled `done` — an all-blocked run stays `active` so the operator can fix the blocker and
re-run without backing the sprint out of review. The `sprint close` CLI command and the close-sprint flow
accept only `review`-status.

**Two-phase planning.** **Refine** (`refine` chain) is implementation-agnostic per-ticket clarification —
no repo exploration; ticket `requirementStatus` flips `pending → approved`. **Plan** (`plan` chain) requires
every ticket `approved`; repo selection runs inside the chain and persists on `Sprint.affectedRepositories`
(absolute paths); AI generates `tasks.json` atomically and the sprint transitions `draft → planned`.
**Ideate** combines both in a single AI session for low-stakes work.

**Per-task generator-evaluator** inside `implement` uses the `loop` primitive. The gen-eval loop body is
`generator-leaf → evaluator-leaf` (looped up to `maxTurns` per attempt, stopping when the evaluator sets
`ctx.lastExit`). Each attempt then runs `settle-attempt` (which records the verdict) plus `append-learnings`
and `progress-journal`; the outer attempt loop re-enters up to `maxAttempts` times per task and transitions
the task to `blocked` once that budget is exhausted. A single launch now runs the outer attempt loop up to
`maxAttempts` times per task — `maxAttempts === 1` is byte-for-byte the prior single-attempt behaviour.
`settings.ai.implement` is a nested
`{ generator, evaluator }` pair — each role carries its own `{ provider, model, effort? }` row, so
the two sessions can run on different providers / models / effort levels (effort resolution rules
described under _AI Settings_ below apply per-row). Default: generator runs `claude-code` /
`claude-opus-4-8`, evaluator runs `openai-codex` / `gpt-5.5` — deep-coder reasoning on the produce
side, an independent reviewer on the score side. Every other flow (`refine` / `plan` / `readiness` /
`ideate` / `createPr`) keeps the flat `{ provider, model, effort? }` row shape; the analogous
generator-evaluator split for the `plan` flow is deferred to future work.

**Legacy `implement` promotion.** Settings files written by ralphctl ≤ 0.7.0 stored `ai.implement`
as a flat `{ provider, model, effort? }` row. Such files are silently promoted at load time into the
nested shape, with `generator` and `evaluator` both set to a copy of the legacy row — no
`schemaVersion` bump and no user-facing notice. The next `save()` rewrites the file in the canonical
nested shape, so the promotion fires at most once per file.

**TUI is the primary surface.** From Home: pipeline-map quick-actions + browse submenu (Sprints / Tickets /
Tasks / Projects). Multi-flow navigation: Tab / Shift+Tab cycle running flows, `Ctrl+1..9` direct-jump,
`SessionsView` lists every runner. `?` opens the centralised help overlay generated from `keyboard-map.ts`.

Execute view: three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail at `md` (100–139),
single-column below `md`. Rail grows fluidly 36→56 cols at `xl`+ via `resolveRailWidth`. Named breakpoints
(`sm 80 / md 100 / lg 140 / xl 180 / xxl 220`) are canonical — use `breakpointFor`, `fluid`, `responsive`,
`useBreakpoint` from `theme/tokens.ts`; no hardcoded column literals. Global keys: `b` banner, `g` progress,
`y` yank, `P` project picker, `S` sprint picker. Execute-view: `j`/`k` nav, `e` verification-criteria, `c` cancel-scope.

**`setupScript` vs `verifyScript`.** Setup runs unconditionally once per affected repo at sprint start;
each attempt is recorded as a structured `SetupRun` (outcome: `success` / `failed` / `spawn-error` /
`skipped`) persisted on `SprintExecution.setupRanAt`. Non-zero exit or spawn failure hard-aborts the
chain. Verify runs both **pre-task** (before the AI) and **post-task** (after commit) with an attribution
algorithm (`clean` / `regressed` / `baseline-broken` / `fixed-baseline`) that avoids blocking the AI for
pre-existing failures. Failure transitions the task to `blocked`, never `done`. `Repository.verifyTimeout`
caps both the pre- and post-task verify calls as `timeoutMs` on the shell runner; when absent the runner
falls back to `DEFAULT_SHELL_TIMEOUT_MS` (5 min). Both scripts are collected during `detect-scripts` and
persisted on `Repository.{setupScript,verifyScript,verifyTimeout}`. Persisted `project.json` files written
before v0.7.0 used `checkScript` / `checkTimeout`; the schema accepts those legacy keys on read and
rewrites the canonical names on the next save (no manual migration step).

**Branch management.** `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
per-task preflight verifies the right branch. `ralphctl create-pr --sprint <id>` opens PR / MR via `gh` /
`glab` and persists `SprintExecution.pullRequestUrl`.

## AI Settings

`settings.ai` is a flat record: one optional global `ai.effort` plus six per-flow rows
`ai.{refine,plan,implement,readiness,ideate,createPr}`, each `{ provider, model, effort? }`.
`detect-scripts` / `detect-skills` reuse the `readiness` row; `review` reuses the `implement` row — no
dedicated settings rows. The `createPr` row drives the optional AI step inside `create-pr --ai`; settings
files written by ralphctl ≤ 0.8.x are missing it and the load path silently seeds it from `ai.refine` (no
`schemaVersion` bump; canonical shape lands on the next save). Per-flow `model` accepts the matching
provider's catalog or any non-empty trimmed custom string; per-flow `effort` validates against the
provider's native vocabulary.

**Effort resolution** at every AI-spawning leaf (`src/business/settings/resolve-effort.ts`): per-flow
`ai.<flow>.effort` wins; otherwise the global `ai.effort` floored to the row's provider ceiling;
otherwise the provider CLI's default. Codex caps at `high` — `xhigh` and `max` collapse to `high` when
floored from the global value; `minimal` is reachable only via an explicit per-flow override.

**Single-provider configurations are first-class.** Every row may point at the same provider, or every row
at a different one; the launcher rebuilds the provider / interactive-AI / skills-adapter trio per launch
keyed on the dispatched flow's row, so mixed and uniform configs traverse the same code path.

**Four equal presets** stamp the entire `ai` section in one shot: `mixed` (best-fit provider per flow),
`claude-only`, `copilot-only`, `codex-only`. None is marked default. Apply via
`ralphctl settings apply-preset <name>` or from the TUI settings view (four buttons above the global
effort row). Re-applying overwrites every row in one transaction; subsequent per-key edits via
`ralphctl settings set ai.<flow>.<field> <value>` stick.

**Fail-fast PATH check.** Every AI-spawning flow probes for its row's CLI binary at launch (`claude` /
`copilot` / `codex` via `src/integration/system/detect-cli.ts`) and exits with `LaunchResult.fail` naming the
binary, the flow, and the offending `settings.ai.<flow>.provider` key when the binary is absent.
`apply-preset` emits non-fatal warnings for any preset row whose CLI is missing at apply time, and the
welcome view silently auto-seeds a preset on fresh install based on what it detects on PATH.

## Security & Safety

**Permission model — two orthogonal axes.** `SessionPermissions` gates **capabilities**
(`canModifyRepoFiles`, `canRunShell`, `canAccessNetwork`, `autoApprove`); `cwd` +
`additionalRoots` + `outputDir` on the `AiSession` define **topology** (which paths the AI
can read / write). Topology is the primary defense; capabilities are the secondary filter.

The `Write` tool is **always allowed** under every profile — the audit-[09] contract requires
the AI to land `signals.json` in `outputDir`. To deny writes to a tree, don't mount it.
`outputDir` is auto-included as a writable root in every provider (see
`providers/_engine/resolve-roots.ts`).

| Provider         | Always passes                         | Read-only profile maps to                            | Native context file               |
| ---------------- | ------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `claude-code`    | `--permission-mode bypassPermissions` | `--disallowedTools Edit,MultiEdit,NotebookEdit,Bash` | `CLAUDE.md` at repo root          |
| `github-copilot` | `--no-ask-user --autopilot --silent`  | `--allow-all-tools --deny-tool=shell`                | `.github/copilot-instructions.md` |
| `openai-codex`   | `-s workspace-write` (no `-a` flag)   | `-s workspace-write` (topology-scoped)               | `AGENTS.md`                       |

Codex caveat: `codex exec` has only two sandbox modes (`read-only` / `workspace-write`), and
`read-only` blocks every write (incl. signals.json). Every profile maps to `workspace-write`;
Codex can't fine-grained-deny edits on existing repo files. Use topology to constrain it.

The `readiness` flow fans out across every uniquely referenced provider in `settings.ai` — one native
context file per provider (claude-code → `CLAUDE.md`, github-copilot → `.github/copilot-instructions.md`,
openai-codex → `AGENTS.md`). Single-provider configurations produce exactly one file; mixed configurations
produce one per distinct provider. No symlinks, no pointer schemes. Don't introduce either.

**Cross-process advisory lock** at `<stateRoot>/locks/repo-<hash>.lock` (sha1 of the repository worktree
path, first 16 hex) serializes whole-flow runs against one working tree so two ralphctl processes can't race
the same repo. Backed by `proper-lockfile` (`file-locker.ts`): the lock is a directory (atomic `mkdir`,
NFS-safe) kept fresh by a background heartbeat, so a LIVE holder is never falsely stolen no matter how long
the run lasts — a crashed holder stops heartbeating and is reclaimed once its mtime passes `staleAfterMs`
(default 30s, clamped 2000–3600000 ms; bounds crash-reclaim latency only). Not env-configurable. A held lock
lost mid-run (`onCompromised`) surfaces a `lock-compromised` warning AND aborts the in-flight run: the
lock-compromised signal is merged into the chain's abort signal (`combineAbortSignals`), so a lost lock tears
the run down as an `AbortError` instead of continuing to mutate a resource a competitor may now own. The lock
is held across the whole run by the implement flow (serial path via `withRepoLock`, parallel path holds the
key directly) and by the review flow (`withRepoLock`, same sprint-dir key — implement and review of one
sprint mutually exclude). `withRepoLock` (`flows/_shared/`) is the one ctx-generic wrapper both use.

**Atomic file writes** via `business/io/write-file.ts` for all persisted state. Direct `fs.writeFile` is
fenced from business code by the layer rules.

**Cross-platform process spawning** goes through `integration/io/cross-platform-spawn.ts`
(`crossPlatformSpawn`, backed by `cross-spawn`) — the single primitive every external-CLI spawn
(`claude` / `codex` / `gh` / `glab` / `git`, headless + interactive) delegates to. Never call
`node:child_process.spawn` directly for a binary: on Node 24 Windows a bare spawn cannot launch the
npm/winget `.cmd` shims, and `shell: true` mis-quotes arguments with spaces or `& | % "`. The
exception is the setup/verify-script runner (`shell-script-runner.ts`), which intentionally keeps
`shell: true` because it runs a user-authored command _string_, not a binary + args.

**`AbortError` is the one error chains propagate transparently.** User-initiated cancellation (Ctrl+C, the
TUI abort hotkey) flows through every wrapper without being absorbed by guards or fallbacks. Anywhere a guard
or fallback catches errors, it MUST exempt `AbortError`. The chain's `AbortSignal` is now threaded all the
way into `implementSession()` via `execute(input, signal)` on every headless AI leaf (generator, evaluator,
review, create-pr, readiness, detect-scripts, detect-skills) — the signal reaches the headless provider's
SIGTERM→SIGKILL kill ladder, abort-aware exit classification, and cancellable rate-limit sleep. Without this
threading a cancel would let the spawned child run to natural completion, stranding the repo lock and leaving
the progress spinner stuck.

**AI sessions plug onto the repo (implement / ideate).** Cwd is the user's repo (multi-repo flows
pick `repositories[0]`); the per-flow sandbox under `<sprintDir>/<flow>/<unit-slug>/` is mounted via
`--add-dir` so `prompt.md` and `signals.json` round-trip through harness-controlled
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

**File-based AI provider contract** — providers write `signals.json` and a `session-id.txt` file per spawn
(both persisted to `<sprintDir>/implement/<unit-slug>/rounds/<N>/<role>/`); the harness reads them
post-spawn. No stdout parsing for signals or session IDs. Replaces a long-standing brittleness vector
when CLI vendors tweak JSON shape.

## Performance & Limits

**Implement runs tasks in dependency order; parallel execution is opt-in.** `Task.order` (set as `i + 1` at parse
time by `parseTaskList` in `src/integration/ai/prompts/_engine/parse-task-list.ts`) is the
intra-level tiebreak; `Task.dependsOn` carries the dependency edges (the planner emits them as
`blockedBy` in the wire format and `parseTaskList` resolves them onto `dependsOn`). Graph validity —
unknown dependency / self-edge / cycle — is owned by `validateTaskGraph` (`src/domain/entity/task-graph.ts`)
and enforced at **both** boundaries: `parseTaskList` calls `scheduleIntoWaves` (Kahn's algorithm by
dependency level, `Task.order` ASC within each level) and rejects the task list on a bad graph, and
`resolveImplementQueue` (`src/application/ui/shared/launch/implement.ts`) re-runs `scheduleIntoWaves`
at launch so a cyclic / dangling sprint fails fast with the rendered `TaskGraphIssue` rather than
silently surfacing as an empty "No tasks to implement" queue. When `settings.concurrency.maxParallelTasks === 1`
(the default), the scheduled levels flatten into one serial queue — byte-for-byte the prior behaviour.
When `maxParallelTasks > 1` (range 1–5, Zod-clamped), the above-the-chain orchestrator `runWaves`
(`src/application/chain/run/wave-scheduler.ts`) runs each dependency wave's tasks concurrently up to
that cap; waves stay strictly sequential (wave k+1 starts only after every branch of wave k settled and
merged). Each task runs in its own isolated git worktree at `<sprintDir>/worktrees/wt-<taskId>`,
forked from the sprint-branch tip; the repo's `setupScript` runs inside each fresh worktree (a
worktree has none of the main repo's build artefacts). A setup failure blocks only that task — it
never hard-aborts the wave. Each worktree's commit is folded onto the single shared sprint branch
(`git merge --ff-only`, else `cherry-pick`) through one serialised in-process fold queue, so a
multi-task parallel sprint lands as one PR. When two same-wave tasks touch the same file the first
folds cleanly; the second's cherry-pick conflicts → that task transitions to `blocked` (`cherry-pick
--abort`, siblings stay `done`); a relaunch re-forks from the advanced tip and usually succeeds.
Waves partition on dependency edges, not file overlap — conflict is resolved at fold time, not
scheduling time. The sprint lock (`repoLockFile(locksRoot, sprintDir)`) spans prologue + waves +
epilogue using the same lock key as the serial path, so a serial and a parallel run of the same
sprint mutually exclude. Commits durably folded before an abort are preserved by the epilogue and
never re-executed on relaunch. Concurrent appends to `progress.md` and the learnings ledger are
serialised through one in-process mutex (no torn lines under fan-out). Launch then applies a
status-only stable override: `in_progress` tasks first (so a resumed sprint picks up the previously
aborted task before any fresh work), then `todo`; V8's stable sort preserves dependency order within
each status group. A `dependency-gate` leaf at the head of every per-task subchain enforces the
prerequisite contract at run time: if any `dependsOn` task is not `done` (blocked or still unsettled),
the dependent is transitioned to `blocked upstream — …` and the subchain body is skipped — no AI
spawn wasted. The gate is status-only and works in both the serial and parallel paths. Block is
transitive by construction (A → B → C cascades automatically). Unblocking the root prerequisite
cascade-unblocks the entire upstream-blocked subtree in one action (`unblockTaskUseCase` calls
`upstreamBlockedDependents` and rewrites the list atomically); own-failure blocks are never
auto-cleared.

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

**Escalation on plateau.** On a plateau the gen-eval loop grants one more attempt rather than settling
immediately. **A plateau never blocks the task** — it either retries once or preserves the work
(done-with-warning). Two `settings.harness` knobs tune it:

- `escalateOnPlateau` (default **`true`**) — flag gate; when off, a plateau keeps the legacy
  done-with-warning-on-first-plateau behaviour (no retry).
- `escalationMap` (default `{}`) — user overrides merged over the built-in ladder. User keys win on
  conflict (allowing redirects) and user-only keys extend the ladder. Self-loops (`{ 'foo': 'foo' }`)
  parse but emit one warn-level log record per entry at settings load.

The one plateau-break attempt does two things: (1) **model escalation** — climbs one rung up
`DEFAULT_ESCALATION_MAP` (`src/business/task/escalation-map.ts`, seeding the common in-provider rungs
Claude Haiku → Sonnet → Opus; Codex / Copilot `gpt-5-mini` and `gpt-5.4-mini` → `gpt-5.5`, kept in
lockstep with `domain/value/settings-models/` by code review) when a stronger rung exists; and (2) a
**"change your approach" directive** (`{{PLATEAU_DIRECTIVE_SECTION}}` in the implement prompt) injected
into that attempt's generator turn, telling it to abandon the non-converging approach and try a
fundamentally different one. For a top-of-ladder generator (e.g. the default Opus) there is no higher
model, so the attempt keeps the model and relies on the directive (a same-model "nudge" — stamped
`escalatedFromModel === escalatedToModel` so the once-per-task cap still fires).

Escalation is generator-only by design — the evaluator's model is held constant across the task so the
scoring rubric does not shift mid-task, which would make plateau detection meaningless. The policy fires
at most once per task (`Task.escalatedFromModel` / `escalatedToModel` are write-once): after the single
plateau-break attempt, a second plateau — or a plateau with no attempt budget left — preserves the work
(done-with-warning), never blocks. Cost ceiling is bounded: at worst one extra attempt per task.
Cross-provider escalation (e.g. `claude-opus-4-8` → `gpt-5.5`) and a multi-rung ladder are intentionally
deferred — switching providers mid-task carries auth / context / tool-availability hazards, and the
same-model nudge already gives a top-of-ladder generator a way to act differently.

**Trace ring buffer.** The runner caps `runner.trace` at `MAX_TRACE_ENTRIES = 5_000`
(`src/application/chain/run/runner.ts`). The `TaskRoundStarted` event (carrying `roundN`,
`attemptN`, `totalCap`) drives the `round N/M` display — replacing the old React-ref high-water mark.

**Optional `<sprintDir>/events.ndjson`** — opt-in via `RALPHCTL_DEBUG_TRACE=1`. When enabled, every
implement-style run appends its full trace, bracketed by `=== chain-run <id> <flowId> started <iso> ===` /
`… completed/failed/aborted …` delimiters. `tail -f`-friendly. The sink is bounded (in-memory drain queue
with drop-newer back-pressure) so it cannot OOM under high event rate. Default factory is no-op so unset
envs incur zero memory cost.

**`progress.md` is an append-only journal** (audit-[07]), not streamed or regenerated. `init-progress-journal`
writes a one-time sprint header at creation; after each `settle-attempt-<taskId>` the `progress-journal` leaf
appends one task-attempt section via `renderJournalEntry` (a pure formatter). It reads no log files — the
canonical state lives in `tasks.json` / `execution.json`. Appends are best-effort: a write failure is logged
and the next attempt's append heals the file.

**Per-round artifacts.** Generator and evaluator prompts land at `rounds/<N>/{generator,evaluator}/prompt.md`
before each spawn; `settle-attempt-leaf` writes `rounds/<N>/outcome.md` after settlement.

**AI signal routing.** `<change>` / `<decision>` / `<learning>` / `<note>` signals accumulate per-attempt on the
implement ctx (`ctx.currentAttempt{Changes,Decisions,Learnings,Notes}`) as the generator / evaluator leaves parse them;
`progress-journal` dedupes each list and `renderJournalEntry` writes the per-attempt `### Changes` / `### Decisions` /
`### Learnings` / `### Notes` subsections (empty subsections are dropped). The same signals also fan out as
`HarnessSignalEvent` on the EventBus for live TUI panels; when `RALPHCTL_DEBUG_TRACE=1` they additionally land in
`<sprintDir>/events.ndjson` for debug — never read back by the harness. A `<learning>` carries a required Insight (
`text`) plus optional `context` (when/why) and `appliesTo` (where); the `### Learnings` subsection renders each as a \*
\*bold Insight\*\* bullet with indented `Context:` / `Applies to:` sub-bullets (omitted when absent) — unlike the flat
single-line bullets for changes, decisions, and notes.

**Procedural memory (learning ledger).** Per-attempt `<learning>` signals are also appended to a
project-scoped append-only NDJSON ledger at `<dataRoot>/memory/<projectId>/learnings.ndjson` by
`appendLearningsLeaf` (inserted immediately before `progress-journal` in the attempt-loop body;
best-effort — a write failure is logged, never fatal). Each `LearningRecord` (the single source of
truth at `src/application/flows/_shared/memory/learning-record.ts`) carries `{ v, id, text, context?, appliesTo?, repo,
repoName, taskKind, sprintId, taskId, timestamp, promotedAt }`; `id` is a stable
`sha1(repo|taskKind|normalize(text))[:16]` dedup key and `promotedAt` is `null` on write.
`text` is the Insight (required); `context` (when/why it arose) and `appliesTo` (where it applies) are optional and
render as indented `Context:` / `Applies to:` sub-bullets in `progress.md` and the distilled `## Learnings (ralphctl)`
section. At sprint
close — BOTH the explicit `close-sprint` flow and the `review` flow's auto-done path — an opt-in,
human-gated **distill** step (defaults to No) promotes curated, not-yet-promoted learnings into each
provider's native context file via the same per-distinct-provider fan-out as `readiness` (one file
per provider, no symlinks), then stamps the accepted ids `promotedAt` so they are never re-proposed.
The self-contained distill sub-chain runs while the sprint is still `review`, so a mid-distill abort
leaves it un-closed and re-runnable. Prompt: `src/integration/ai/prompts/distill-learnings/`;
implementation: `src/application/flows/_shared/memory/`.

**Skill suggestions.** The `readiness` flow acts on `SkillSuggestionsSignal`: after `write` and
before `install-readiness-skills`, `offerSkillSuggestionsLeaf` surfaces each suggested skill —
a bundled skill gets an install confirm, an unknown skill gets a scaffold confirm. The human gate is
mandatory; nothing auto-installs. Accepted suggestions persist on `Repository.suggestedSkills`.
Resolution uses the `SkillSource.getByName` lookup on the bundled source.

`settings.ui.notifications.enabled` (default `true`) gates terminal bell + macOS `osascript`.

**Environment variables.**

| Variable                     | Default        | Range / values   | Purpose                                                          |
| ---------------------------- | -------------- | ---------------- | ---------------------------------------------------------------- |
| `RALPHCTL_HOME`              | `~/.ralphctl/` | absolute path    | Override application root (data + config + state)                |
| `RALPHCTL_SKIP_LEGACY_CHECK` | unset          | any truthy value | Bypass the v0.6.x legacy-layout detector at boot                 |
| `RALPHCTL_DEBUG_TRACE`       | unset          | any truthy value | Enable `<sprintDir>/events.ndjson` debug sink (no-op when unset) |
| `RALPHCTL_NO_TUI`            | unset          | any truthy value | Suppress implicit interactive prompts inside the implement flow  |
| `NO_COLOR`                   | unset          | any truthy value | Suppress ANSI colors                                             |
| `CI`                         | auto-detected  | any truthy value | Suppress implicit interactive prompts inside the implement flow  |

**Release procedure.** GitHub Actions auto-publishes on tags `v[0-9]+.[0-9]+.[0-9]+`. Tag must match
`package.json#version`; `CHANGELOG.md` needs a `## [X.Y.Z]` section (the literal-prefix extractor surfaces
it). NPM publish uses `--provenance`. Pre-releases are tags containing `-`.

**References** — Principles distilled in `.claude/docs/HARNESS-PRINCIPLES.md`; consult before structural
changes to the chain framework, flow registry, or provider engine. Sources: [Anthropic — Effective
Harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Anthropic
— Harness Design](https://www.anthropic.com/engineering/harness-design-long-running-apps), [Martin Fowler
— Harness Engineering](https://martinfowler.com/articles/harness-engineering.html).
