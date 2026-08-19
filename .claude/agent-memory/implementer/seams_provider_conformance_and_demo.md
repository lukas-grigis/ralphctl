---
name: seams_provider_conformance_and_demo
description: The src-side scripted-spawn builder shared by the conformance suites and `ralphctl demo --script`, the buildEnv/effortForwarding contracts, and the lint gotchas around them
metadata:
  type: project
---

## The scripted-child builder lives in `src/`, deliberately

`createScriptedChild(source, hooks)` is in
`src/integration/ai/providers/_engine/scripted-spawn.ts`, NOT in `tests/fixtures/`.
`tests/fixtures/provider-spawn-fake.ts` only COMPOSES it, adding the per-call
`{command, args, cwd, stdin, kills}` recording.

**Why:** the shipped `ralphctl demo` replays a canned transcript through the real claude adapter, and
`tsup.config.ts` aliases `@tests` — importing a fixture from `src/` would silently bundle test code into
`dist/`. Two copies of the builder would then let tested behaviour and demo behaviour drift.

Anything fabricating a `ChildProcessWithoutNullStreams` goes through it. `SpawnScriptSource` accepts a
thunk resolved at emission time — one macrotask after construction, i.e. AFTER the adapter wrote stdin —
which is the seam for "parse the prompt off stdin, then decide the response". `trapsSigterm` is what
makes the SIGTERM → grace → SIGKILL ladder observable; without it the first rung ends the child and the
caller cancels the grace timer.

## Contracts settled alongside the conformance suites

- **`InteractiveProviderSpec.buildEnv(input, context)` returns `Result<Record<string,string>,
DomainError>`**, evaluated BEFORE the start-log publish and before the spawn. It used to take `input`
  only with no error channel, which is _structurally_ why the OpenCode interactive adapter dropped
  `additionalRoots`: it could neither see the engine's folded root list nor refuse. **Any new
  env-configured adapter must consume `context.roots`, never re-walk the input.**
- **`ProviderTraits.effortForwarding: { headless, interactive }`** — effort capability is per SURFACE,
  not per provider (only `opencode.interactive` is false: `--variant` is `run`-only and the TUI command
  is yargs-strict). The conformance tables assert argv against this declaration in BOTH directions.
- The conformance suites under `tests/integration/ai/providers/conformance/` each end with a
  row-set-vs-`PROVIDER_TRAITS` completeness guard, so a new backend cannot land without a row.

## `ralphctl demo --script`

Replays a canned generator → evaluator transcript through the REAL chain (real git, real verify gate,
real contract validation) by swapping only the AI adapters' spawn — a first-run recording must not need
an authenticated provider CLI, and a mocked chain would prove nothing.

- **Four wiring points, not one.** `WireOptions.providerSpawn` (AI-only; distinct from
  `WireOptions.spawn`, which doubles as the general git/gh `Spawn`) → `AppDeps.providerSpawn` → (a)
  `buildLaunchAdapters` in `launcher.ts` and (b) the implement launcher's own per-role rebuild.
  **Implement bypasses `buildLaunchAdapters` entirely** — `buildImplementProviders` constructs one
  provider per role from settings — so a launcher-only fix leaves implement spawning the real CLI.
  Presence of `AppDeps.providerSpawn` is also the "nothing will be spawned" signal that skips the
  `checkCli` PATH pre-flight; note that skip is wired into `launch/implement.ts` only, so the seeded
  sandbox's Plan/Refine entry points still hit the pre-flight.
- **Dispatch off the round directory, and anchor the regex on the whole tail.** The scripted spawn
  learns what to write by scraping `…/rounds/<N>/(generator|evaluator)/signals.json` out of the prompt
  on stdin (the harness embeds that absolute path via `renderContractSection`). A looser "any path
  ending in signals.json" match silently locks onto the evaluate template's prose placeholder
  `` `<outputDir>/signals.json` `` and the whole run blocks with "does not script this output path".
  Regression-fenced in `tests/integration/application/demo/scripted-spawn.test.ts`.
- **Writes inside the scripted-child thunk must be synchronous** — `createScriptedChild` resolves the
  thunk, emits stdout and exits within one macrotask, so `signals.json` must be on disk before the thunk
  returns.
- **Transcript beats are typed as `typeof <role>OutputContract.exampleSignals`**, so leaf contract drift
  breaks at typecheck instead of at demo time.
- **Pin the sandbox before replaying** (`src/application/demo/scripted-run.ts`): claude-code on every AI
  row (one stream format to emulate), `bestOfNCandidates: 0` + `escalateOnPlateau: false` (a two-round
  script has no beat for an escalation rung), and node one-liners for the seeded verify script /
  criterion. The repo verify script must be GREEN at baseline — a red pre-task-verify opens the "proceed
  on a broken tree?" operator gate mid-recording.

## Two lint gotchas hit landing this

- A multi-line `//` rationale block followed by `eslint-disable-next-line` does NOT work — each `//` is
  its own comment node, so the directive disables the _next comment line_ and then reports "unused
  eslint-disable directive". Put the prose first, the directive on the LAST line.
- `pnpm lint` is `eslint . --max-warnings 0`. Flat-config `reportUnusedDisableDirectives` defaults to
  `warn`, so at zero a directive that later becomes unnecessary ALSO fails lint.

Related: [[seams_provider_engine_streaming]], [[seams_model_catalog_refresh]], [[project_release_gate_seams]].
