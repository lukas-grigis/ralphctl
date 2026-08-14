---
name: demo-scripted-spawn-seam
description: ralphctl demo --script — AppDeps.providerSpawn survives the per-launch adapter rebuild; the scripted transcript is dispatched off the rounds/<N>/<role>/signals.json path scraped from the prompt
metadata:
  type: project
---

`ralphctl demo --script` replays a canned generator → evaluator transcript through the REAL chain
(real git, real verify gate, real contract validation) by swapping only the AI adapters' spawn.

**Why:** a first-run recording must not need an authenticated provider CLI, and a mocked chain
would prove nothing. Landed 2026-08-14 alongside the honest-doctor / welcome-gate / `ralphctl demo`
waves (feature C of the trustworthy-first-run branch).

**How to apply:**

- **Four wiring points, not one.** `WireOptions.providerSpawn` (AI-only; distinct from
  `WireOptions.spawn`, which doubles as the general git/gh `Spawn`) → `AppDeps.providerSpawn` →
  (a) `buildLaunchAdapters` in `launcher.ts` and (b) the implement launcher's own per-role rebuild.
  Implement bypasses `buildLaunchAdapters` entirely — `buildImplementProviders` constructs one
  provider per role from settings — so a launcher-only fix leaves implement spawning the real CLI.
  Presence of `AppDeps.providerSpawn` is also the "nothing will be spawned" signal that skips the
  `checkCli` PATH pre-flight.
- **Dispatch off the round directory, and anchor the regex on the whole tail.** The scripted spawn
  learns what to write by scraping `…/rounds/<N>/(generator|evaluator)/signals.json` out of the
  prompt on stdin (the harness embeds that absolute path via `renderContractSection`). A looser
  "any path ending in signals.json" match silently locks onto the evaluate template's prose
  placeholder `` `<outputDir>/signals.json` `` and the whole run blocks with "does not script this
  output path". Regression-fenced in `tests/integration/application/demo/scripted-spawn.test.ts`.
- **Writes inside the scripted-child thunk must be synchronous.** `createScriptedChild`
  (`integration/ai/providers/_engine/scripted-spawn.ts`) resolves its script thunk, emits stdout
  and exits within one macrotask, so `signals.json` has to be on disk before the thunk returns.
- **Demo transcript beats are typed as `typeof <role>OutputContract.exampleSignals`** so leaf
  contract drift breaks at typecheck instead of at demo time.
- **Pin the sandbox before replaying** (`src/application/demo/scripted-run.ts`): claude-code on
  every AI row (one stream format to emulate), `bestOfNCandidates: 0` + `escalateOnPlateau: false`
  (a two-round script has no beat for an escalation rung), and rewrite the seeded `python3 hello.py`
  verify script / criterion to node one-liners. The repo verify script must stay GREEN at baseline —
  a red pre-task-verify opens the "proceed on a broken tree?" operator gate mid-recording.
- Related: [[project_provider_port_conformance_seam]] (the shared scripted-child builder in `src/`).
