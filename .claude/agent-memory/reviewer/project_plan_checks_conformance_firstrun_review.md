---
name: plan-checks-conformance-firstrun-review
description: Review of feature/plan-checks-conformance-first-run (3 council features, 4 commits, 2026-08-14) — literal NUL bytes in a test file and demo --script's checkCli-skip scoped to implement only
metadata:
  type: project
---

Reviewed 2026-08-14, pre-PR, ~76 files / +4.9k-0.5k. Three council-approved features by parallel
agents: plan-check leaf (`check-plan`/`apply-plan` split off `call-planner-interactive`), provider
port-conformance suite + #278 opencode interactive root-grant fix, first-run bundle (honest doctor
auth probes, welcome keypress gate, `ralphctl demo`/`--script`). Gate was green going in
(typecheck/lint/test); I additionally ran `pnpm format:check` and `pnpm deadcode` — both clean too.

**Two real findings, both non-blocking-but-should-fix:**

1. **Literal NUL bytes (`\x00`) in `tests/integration/ai/providers/conformance/interactive-port-conformance.test.ts`**
   at 5 call sites (`call.args.join('\x00')` etc., lines ~157/160/197/201/209) — someone typed an
   actual NUL byte instead of the 4-char escape sequence `'\x00'`. Semantically identical at
   runtime (same single NUL char either way), but the file is opaque to `git diff` (`Bin 0 ->
10809 bytes` in `git diff --stat`, `file` reports "data" not "text") — GitHub's PR view won't
   render a text diff for it, and `git blame`/most greps mishandle it. `pnpm format:check` and
   `pnpm lint` do NOT catch this (string-literal content, invisible to both). Detection recipe:
   `LC_ALL=C grep -naP '\x00' <file>` or a python byte-scan; `git diff --stat` showing `Bin` on a
   `.ts` file is the tell.
2. **`ralphctl demo --script`'s `checkCli` PATH-preflight skip is wired only into
   `launch/implement.ts`** (`preflightCli`), not into `launch/plan.ts` / `refine.ts` / `ideate.ts`
   / `readiness.ts`. The implementer's own memory
   (`.claude/agent-memory/implementer/project_demo_scripted_spawn_seam.md`) states the design
   intent as general ("Presence of `AppDeps.providerSpawn` is also the 'nothing will be spawned'
   signal that skips the `checkCli` PATH pre-flight") but the seeded demo sandbox
   (`src/application/demo/seed.ts`) surfaces THREE pre-flow sprints, two of which
   ("ready to refine" / "ready to plan") explicitly invite the no-CLI user into flows that were
   never wired with the skip — so on a machine with zero AI CLI installed, following the sandbox's
   own state labels into Plan or Refine during `--script` mode fails with a graceful but
   surprising "CLI ... not on PATH" `LaunchResult`. Not a crash (checkCli fails cleanly), and the
   playbook/changelog only ever demonstrate the Implement path, so this may be accepted as
   documented scope rather than fixed — flag it either way (extend the skip, or narrow what the
   seeded sprint states / stdout blurb imply about `--script`).

**Everything else checked out clean** — worth remembering as a positive baseline for this codebase's
conformance-suite pattern: `interactive-port-conformance.test.ts` /
`headless-port-conformance.test.ts` genuinely assert `effortForwarding` both directions per
`PROVIDER_TRAITS` row (not tautological), the `check-plan.ts` business-layer 9-finding-kind table
is individually exercised (not just the `SEVERITY_BY_KIND` completeness stub), the `buildEnv`
refusal-before-start-log-before-spawn ordering in `run-interactive-session.ts` is pinned by a
dedicated test, and `wire.ts`'s `providerSpawn = opts.providerSpawn ?? opts.spawn` fallback
preserves old wiring byte-for-byte when no override is set.

Related: `seams_provider_conformance_and_demo` (implementer's memory on the same suite),
`project_trustworthy_firstrun_waves12_2026-08-14` (implementer's memory on the doctor/welcome/demo
waves).
