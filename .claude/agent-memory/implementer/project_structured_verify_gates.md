---
name: structured-verify-gates
description: WS3 per-module verify gates — domain shape, multi-gate executor representation, diff-footprint seam, pre/post asymmetry
metadata:
  type: project
---

`Repository.verifyGates?: readonly VerifyGate[]` (`{ pathPrefix; command; timeoutMs? }`) lets a monorepo verify
only the modules an attempt's diff touched instead of paying every module on every run. Landed on
feat/gen-eval-speed (Phase 3, tasks T8/T10/T11/T12; 2026-06-10).

**Why:** a measured sprint ran 228 Java tests 2x (pre+post) for a web-ui-only diff — the opaque single
`verifyScript` chains all module gates.

**How to apply (the non-obvious decisions):**

- **Precedence:** `verifyGates` wins when present AND non-empty; legacy `verifyScript` ≡ single catch-all gate
  `{ pathPrefix: '', command }`. `normalizeVerifyGates(script, gates)` in `business/task/run-verify-script.ts`
  collapses both into ONE list so there's one code path. `''` prefix matches everything.
- **VerifyRun representation for multi-gate (entity shape UNCHANGED, per plan — per-gate audit deferred):**
  aggregate `outcome='success'` only if every executed gate passed; on failure the FIRST non-success gate
  decides `command`/`exitCode` (points at the culprit); on all-pass `command` is the `'; '`-joined executed
  commands. `durationMs` sums executed gates. `rawOutput` concatenates each gate behind a `── <command> ──`
  separator (single-gate run = bare output, byte-for-byte legacy). New use case `runVerifyGatesUseCase`;
  legacy `runVerifyScriptUseCase` kept verbatim for its existing tests/callers.
- **Mode is caller-chosen, never a heuristic:** `mode: 'fail-fast' | 'all-run'`. Post-verify = fail-fast +
  diff scope; pre-verify = all-run + NO scope (baseline needs the complete picture → like-vs-like attribution,
  post's executed set ⊆ pre's full set, so a scoped red post on green pre is still `regressed`).
- **Diff-footprint seam:** `gitDiffFootprint(runner, cwd)` in `integration/io/git-operations.ts` =
  `git diff --name-only HEAD` ∪ `git ls-files --others --exclude-standard` (untracked, de-duped). post-task
  -verify calls it ONLY when structured gates are configured. CRITICAL fallback: footprint error OR empty →
  `computeScope` returns `undefined` → run ALL gates (never silently skip), logged.
- **Scope filtering ONLY applies when `opts.verifyGates` is present + non-empty** — the legacy single catch-all
  gate skips the git probe entirely (it matches every path anyway).
- post-task-verify leaf now needs `gitRunner` in its Deps (wired from `deps.gitRunner` in per-task-subchain.ts).
- See [[project_recoverable_turn_error_policy]] and the T6 retry: `regressed` semantics UNCHANGED by gating.

**T9 (detect-scripts emission of structured gates) is a SEPARATE follow-up** — not done here. `domain/signal.ts`
and detect-scripts were explicitly out of scope. `setRepositoryVerifyGates` setter exists but has no production
caller yet (only tests) — T9 is its first consumer.

Deviation recorded in HARNESS-PRINCIPLES.md under #9 (T12).
