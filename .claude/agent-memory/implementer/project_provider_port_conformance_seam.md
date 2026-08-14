---
name: provider-port-conformance-seam
description: Provider port conformance suites + the src-side scripted-spawn seam they share with the demo command; buildEnv roots+Result contract; eslint-disable-last-line and max-warnings-0 gotchas
metadata:
  type: project
---

The fake-child-process builder lives in `src/integration/ai/providers/_engine/scripted-spawn.ts`, NOT in
`tests/fixtures/`. `tests/fixtures/provider-spawn-fake.ts` only COMPOSES it, adding the per-call
`{command,args,cwd,stdin,kills}` recording.

**Why:** the shipped `ralphctl demo` replays a canned transcript through the real claude adapter, and
`tsup.config.ts` aliases `@tests` — importing a fixture from `src/` would silently bundle test code into
`dist/`. Two copies of the builder would then let the tested behaviour and the demo behaviour drift.

**How to apply:** anything that needs to fabricate a `ChildProcessWithoutNullStreams` goes through
`createScriptedChild(source, hooks)`. `SpawnScriptSource` accepts a thunk resolved at emission time (one
macrotask after construction — i.e. AFTER the adapter wrote stdin), which is the seam for
"parse the prompt off stdin, then decide the response". `trapsSigterm` is what makes the
`SIGTERM → grace → SIGKILL` ladder observable; without it the first rung ends the child and the caller
cancels the grace timer.

Related contracts settled at the same time:

- `InteractiveProviderSpec.buildEnv` takes `(input, context)` and returns
  `Result<Record<string,string>, DomainError>`, evaluated BEFORE the start-log publish and before the spawn.
  It used to take `input` only with no error channel, which is _structurally_ why the OpenCode interactive
  adapter dropped `additionalRoots` (#278): it could neither see the engine's folded root list nor refuse.
  Any new env-configured adapter must consume `context.roots`, never re-walk the input.
- `ProviderTraits.effortForwarding: { headless, interactive }` — effort capability is per SURFACE, not per
  provider (only `opencode.interactive` is false: `--variant` is `run`-only and the TUI command is
  yargs-strict). The conformance tables assert argv against this declaration in BOTH directions.
- The conformance suites (`tests/integration/ai/providers/conformance/`) each end with a
  row-set-vs-`PROVIDER_TRAITS` completeness guard, so a fifth backend cannot land without a row.

Two lint gotchas hit while landing this:

- A multi-line `//` rationale block followed by `eslint-disable-next-line` does NOT work — each `//` is its
  own comment node, so the directive disables the _next comment line_ and then reports "unused eslint-disable
  directive". Put the prose first and the directive on the LAST line.
- `pnpm lint` is now `--max-warnings 0` (was 1; the single `runner.ts` `max-lines-per-function` warning is
  scoped away with a targeted disable). Flat-config `reportUnusedDisableDirectives` defaults to `warn`, so at
  0 a directive that later becomes unnecessary also fails lint. See
  [[provider-literal-duplication-lint-cap]] for the previous ratchet.
