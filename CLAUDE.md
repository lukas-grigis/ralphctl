# RalphCTL — Agent Harness for AI Coding Tasks

Node.js 24 + TypeScript + Ink TUI. Three AI provider backends (Claude Code / GitHub Copilot / OpenAI Codex).
The TUI is the primary surface; the CLI exposes inspection + one-shot operations only.

Version is read from `package.json` via JSON import attribute in `src/business/version/cli-metadata.ts`.
Both `commander.version()` and the npm-update poll consume the same constant — bin and registry cannot drift.

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
pnpm skills:update     # re-vendor upstream SKILL.md into scripts/vendor/skills/ for review (maintainers only)
```

Before every commit, run `/verify` (wraps `pnpm typecheck && pnpm lint && pnpm test`). All three must pass.
Pre-commit hook runs `lint-staged` (ESLint + Prettier on staged files); `pnpm lint:fix` / `pnpm format` patch.

Requirements: Node.js 24+ (managed via `mise.toml`), pnpm 10+, one of the supported AI CLIs in PATH and
authenticated.

## Read on demand

Not auto-imported — open with the `Read` tool when the work touches the area.

- `.claude/docs/ARCHITECTURE.md` — module layout, ports, repository interfaces, data models, error tables
- `.claude/docs/KERNEL-DESIGN.md` — chain framework reference (`element` / `leaf` / `sequential` / `loop` / `guard`)
- `.claude/docs/WORKFLOWS.md` — sprint lifecycle + state table, two-phase planning, gen-eval loop, TUI navigation, setup/verify, branch management
- `.claude/docs/AI-SETTINGS.md` — `settings.ai` shape, effort resolution, presets, fail-fast PATH check
- `.claude/docs/SECURITY.md` — permission model, cross-process lock, spawning, AbortError rule, skills, refine write-back, file-based provider contract
- `.claude/docs/PERFORMANCE.md` — scheduler / parallel waves, rate-limit retry, iteration budget, plateau escalation, progress journal, learning ledger, env vars, release procedure
- `.claude/docs/REQUIREMENTS.md` — acceptance-criteria checklist
- `.claude/docs/DESIGN-SYSTEM.md` — TUI tokens, components, copy rules
- `.claude/docs/MANUAL-TEST-PLAYBOOK.md` — manual smoke-test script
- `.claude/docs/HARNESS-PRINCIPLES.md` — distilled harness research (Anthropic + Fowler); consult before structural
  changes to the chain framework, flow registry, or provider engine
- `.claude/docs/diagrams/` — Mermaid sequence / data-flow diagrams: chain framework, flow lifecycle, sprint lifecycle,
  task lifecycle, AI-session data flow

## Architecture invariants

**Four-module Clean Architecture** under `src/`: `domain → business → integration → application`. Inner
layers cannot import outer layers; `domain` and `business` cannot import I/O-bearing `node:*` modules (pure
`node:path` / `node:url` / `node:util` … is allowed). ESLint `no-restricted-imports` in `eslint.config.ts`
enforces every direction. Full detail in `.claude/docs/ARCHITECTURE.md`.

- **Function-first.** Use cases are factory functions returning `{ execute(input) }`. No `class` outside
  `src/domain/value/error/`. No `this`. ESLint asserts this.
- **Per-aggregate repositories** under `src/domain/repository/<aggregate>/`. Business code consumes **slim
  sub-ports** from `domain/repository/_base/` (`FindById`, `Save`, `Remove`); the composition root wires the
  composite. Importing composite `*Repository` types from business code is fenced.
- **Sprint splits into three on-disk files** at `<dataRoot>/sprints/<id>--<slug>/`: `sprint.json` (planning),
  `execution.json` (branch / PR URL / setup audit), `tasks.json` (task list). Project files live at
  `<dataRoot>/projects/<id>--<slug>.json`; memory dirs at `<dataRoot>/memory/<id>--<slug>/`. Resolvers tolerate
  the legacy bare `<id>` form. A `data/.ralphctl-data-version.json` stamp tracks migration state; the TUI
  shows a one-time consent splash + backup before renaming existing entries.
- **Chain primitives** in `src/application/chain/`: `element` / `leaf` / `sequential` / `loop` / `guard`
  (factory functions). **No `retry` or `onError`** — retry-on-429 is an adapter concern; branching belongs
  inside a use case or a `guard`. `leaf(name, config, { label? })` — `name` is the canonical identifier;
  `label` is an optional display string for the TUI rail / trace.
- **Flow registry** in `src/application/registry.ts` — every user-launchable flow is one `FlowManifest`.
  Add a flow = append one entry.
- **Composition root is `wire()`** at `src/application/bootstrap/wire.ts` — pure, returns `AppDeps`. Tests
  build from a tmpdir via `storagePathsFromRoot(tmpDir)`. Each flow declares a slim `<Flow>Deps` subset.
- **EventBus** (`business/observability/event-bus.ts`) is the chain-progress fan-out; the Logger
  (`createEventBusLogger`) publishes to the same bus. **One bus per `wire()` call.**
- **Session scoping via `AsyncLocalStorage`** (`src/application/session/session.ts`); the runner wraps every
  `element.execute()` in `runWithSession(id, …)` so deep adapters read `currentSessionId()` without threading.
- **Sibling-isolation** in `integration/ai/<concept>/` — each per-tool / per-variant adapter directory is
  independent; cross-sibling access goes through `_engine/`. Port-shaped interfaces (`*Port`, `*Adapter`,
  `*Provider`, `*Sink`, `*Loader`, `*Probe`, …) MUST live in `_engine/`.
- **Ink TUI** at `src/application/ui/tui/`; bare `ralphctl` mounts via `launchTui` → `createInkHost`
  (`alternateScreen: true`). The mount is unconditional **except** the TTY pre-flight at the top of
  `launchTui`: a non-TTY stdin/stdout (pipe / CI / cron) bails with a one-line stderr hint + exit 1 rather
  than dumping Ink's raw-mode stack trace. `theme/tokens.ts` is the single source of visual truth — no inline
  hex / glyph / spacing. See `.claude/docs/DESIGN-SYSTEM.md`.
- **CLI** at `src/application/ui/cli/` — inspection + one-shot operations only; interactive flows
  (`refine` / `plan` / `ideate` / `implement` / `readiness` / `create-sprint`) stay TUI-only by design.

## Implementation style

Lint/type rules — layer direction, no `class` outside `domain/value/error/`, no barrels, no direct
`typescript-result` / `fs.writeFile` / `node:child_process.spawn` / `@inquirer/prompts` imports — are
ESLint-fenced; `pnpm lint` catches them, so they are not restated here. What the linter cannot enforce:

- **Result types** — every business operation returns `Result<T, DomainError>` from `@src/domain/result.ts`;
  the success type goes _inside_ the envelope (`Result<FooOutput, FooError>`), never `type Foo = Result<…>`.
  Throws are reserved for programmer errors (ctx-shape violations inside leaf projections).
- **`AbortError` propagates transparently** — any guard / fallback that catches errors MUST exempt it.
- **`@public`-tag** any export you intentionally keep after dead-code cleanup (`knip.json` whitelists it;
  `pnpm deadcode` exits 0 on a clean tree).

Repository seams — reach for these rather than rolling your own:

- Prompts → the injected `InteractivePrompt` port (`createInkInteractivePrompt` is the only impl).
- CLI / TUI → flow factories in `application/flows/<flow>/` + the `createRunner` chain runner, not use cases directly.
- Persisted writes → `business/io/write-file.ts` (atomic). External-CLI spawns →
  `integration/io/cross-platform-spawn.ts` (`.claude/docs/SECURITY.md` names the one exception).
- Provider logic → `providers/<tool>` via `HeadlessAiProvider` / `InteractiveAiProvider` from `providers/_engine/`.

### Prompt templates

Live under `src/integration/ai/prompts/<flow>/template.md` plus partials in `_partials/`. Each template ships
a branded `Prompt` type + parameter schema; regressions surface at typecheck.

- `{{VARIABLE}}` placeholders may be empty — avoid numbered lists that gap on empty substitution.
- Em-dash (`—`) not hyphen for explanatory clauses.
- No hardcoded package-manager commands (`pnpm`/`npm`/`pip`/`cargo`/`go test`) outside `{{PROJECT_TOOLING}}`
  or `{{CHECK_GATE_EXAMPLE}}`. Downstream ecosystems differ.
- Reference `.claude/` directories as "when present" — many downstream repos lack one.
- `never`/`always` rules name their exception inline.
- Every prompt directory has a `tests/integration/ai/prompts/<flow>/definition.test.ts` asserting
  placeholder ↔ parameter parity (both directions). The meta-test at `template-coverage.test.ts`
  fails the suite when a new flow lands without one.
