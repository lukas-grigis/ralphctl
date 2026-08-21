---
name: seams_verify_gates
description: Per-module verify gates — precedence and normalization, multi-gate VerifyRun representation, diff-footprint scoping and the coverage flag, the fresh-setup skip, and the detect-scripts emission path
metadata:
  type: project
---

Files: `business/task/run-verify-script.ts`, `flows/implement/leaves/{pre,post}-task-verify.ts`,
`integration/io/git-operations.ts`, `flows/detect-scripts/`,
`integration/ai/contract/_engine/signals/verify-gates/schema.ts`.

`Repository.verifyGates?: readonly VerifyGate[]` (`{ pathPrefix; command; timeoutMs? }`) lets a monorepo
verify only the modules an attempt's diff touched. The motivating measurement: a sprint ran 228 Java
tests twice (pre + post) for a web-ui-only diff, because the opaque single `verifyScript` chains every
module gate.

## Precedence and normalization

`verifyGates` wins when present AND non-empty; legacy `verifyScript` is equivalent to a single catch-all
gate `{ pathPrefix: '', command }` (`''` matches everything). `normalizeVerifyGates(script, gates)`
collapses both into ONE list so there is a single code path. `runVerifyGatesUseCase` is the new use case;
`runVerifyScriptUseCase` is kept verbatim for its existing callers and tests.

## Multi-gate VerifyRun representation (entity shape unchanged)

- aggregate `outcome='success'` only if every executed gate passed;
- on failure the FIRST non-success gate decides `command`/`exitCode`, so the record points at the culprit;
- on all-pass, `command` is the `'; '`-joined executed commands;
- `durationMs` sums executed gates;
- `rawOutput` concatenates each gate behind a `── <command> ──` separator — a single-gate run is bare
  output, byte-for-byte legacy.

Per-gate audit records were deliberately deferred.

## Mode is caller-chosen, never a heuristic

`mode: 'fail-fast' | 'all-run'`.

- **post-verify** = fail-fast + diff scope.
- **pre-verify** = all-run + NO scope. The baseline needs the complete picture for like-vs-like
  attribution: post's executed set ⊆ pre's full set, so a scoped red post on a green pre is still
  legitimately `regressed`.

## Diff-footprint scoping

`gitDiffFootprint(runner, cwd)` (`integration/io/git-operations.ts`) is
`git diff --name-only HEAD` ∪ `git ls-files --others --exclude-standard`, de-duped. post-task-verify
calls it ONLY when structured gates are configured — the legacy catch-all gate skips the git probe
entirely since it matches every path anyway. The post-task-verify leaf therefore needs `gitRunner` in its
Deps (wired from `deps.gitRunner` in per-task-subchain.ts).

**CRITICAL fallback:** a footprint error OR an empty footprint makes `computeScope` return `undefined` →
run ALL gates, logged. Never silently skip.

## The coverage flag — a scoped green is not whole-tree evidence

`runPostVerifyGates` returns `coveredAllGates = scope === undefined`, riding `LeafOutput` →
`ctx.priorPostVerifyOutcome.{cwd,outcome,coveredAllGates}`. `isCarriedGreenForThisCwd` requires
`coveredAllGates === true`; an absent flag (older ctx) counts as NOT covered, so the real gate runs.

Without it, a gate already red OUTSIDE task N's footprint mis-attributes as `regressed` on task N+1 —
burning the retry, quarantining a correct diff, and bypassing both the `baseline-broken` hatch and the
persisted `baselineBrokenPolicy: 'proceed'` amnesty, because the recorded pre reads `success`. Serial
path only: `forkCtx` drops the field on the parallel path.

## Fresh-setup pre-verify skip

`ctx.setupVerifiedRepoIdsThisRun` (run-scoped set of repo ids whose setup ran green THIS launch) is set
by the `setup-script-runner` output projection **only on the fresh green-run path** — NOT resume-skip and
NOT no-script-skip, since those successes belong to a prior launch and validate nothing. `pre-task-verify`
reads it for its short-circuit, gated on `!carriedGreenForThisCwd` so it fires only for the FIRST task of
a run (tasks 2..N use the existing carry-baseline short-circuit).

Settings key `harness.skipPreVerifyOnFreshSetup`, default false; the schema's `.default(false)` self-heals
legacy files, so no migration is needed.

## detect-scripts emission

ONE `VerifyGatesSignal { type:'verify-gates', gates: VerifyGateProposal[] }` carrying an array, modelled
on `SkillSuggestionsSignal` — NOT one signal per gate, which would create an "at most one of each kind"
coordination problem.

- **`verifyGatesSignalSchema` uses `.nonempty()`** — an empty `gates: []` is REJECTED. Single-module repos
  OMIT the signal entirely, so an empty array can never masquerade as "no modules".
- Field-name drift between template and Zod schema silently drops the WHOLE signal, so the schema, the
  template's `<output_contract>`, and the worked JSON example all name the exact keys —
  `gates[].pathPrefix`, `gates[].command`, `gates[].timeoutMs?` — pinned by a definition-test assertion.
- Write path: the entity setter `setRepositoryVerifyGates` existed before `verifyGates` was wired into
  `RepositoryUpdate` / `updateRepository` (project.ts). Both are wired now; the detect-scripts write leaf
  persists via `updateRepository`.
- Gates are NOT inline-editable in the confirm leaf — a single-line text prompt cannot tweak a structured
  map. They ride through approve/edit verbatim and count toward `accepted`; only the legacy `verifyScript`
  fallback is line-editable.
- Adding a member to the `HarnessSignal` union forces a case in the exhaustive `rowForSignal` switch in
  `tasks-panel-internals/signal-rows.tsx` (no `default`).
- House rule held: no hardcoded package managers in the gate-guidance PROSE; the worked JSON example uses
  the `<tool>` placeholder convention. The package-manager negative-match test must anchor on the bold
  CONSTRAINT heading, NOT the same phrase in the success-criteria summary (which slices through the JVM
  constraint).

Related: [[seams_attempt_ctx_and_telemetry]], [[seams_plateau_and_turn_errors]].
