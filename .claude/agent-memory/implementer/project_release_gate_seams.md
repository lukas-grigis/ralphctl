---
name: release-gate-seams
description: Release/CI gate seams — vitest FORCE_COLOR pin, CLI terminal error frame, npm-pack prefix trap, prompts-list resolver gate, and the pre-release tag/dist-tag pair
metadata:
  type: project
---

Five seams around the release/CI gates (hardened 2026-08-18, branch `chore/maintenance-hardening`;
seam 5 added 2026-08-19 for #305).

**1. Colour is PINNED in `vitest.config.ts`, per project (`env: { FORCE_COLOR: '0' }`).**
**Why:** every TUI assertion is a plain-substring check on `lastFrame()`; an ambient `FORCE_COLOR`
(Claude Code exports `FORCE_COLOR=3`) makes chalk split those substrings with SGR codes and 27
assertions across 13 files went red on a pristine tree. Never add `NO_COLOR: '1'` alongside it —
`useNoColor()` reads NO_COLOR to swap in the shape-glyph fallback, so pinning it suite-wide would
run every test through the fallback path and neuter `tasks-panel-no-color.test.tsx`.
**How to apply:** shared `stripAnsi` lives in `tests/integration/application/ui/tui/_harness.tsx`
(use it for width/geometry assertions). `ci.yml`'s `cold-install` job runs `pnpm test` with
`FORCE_COLOR: 3` on purpose — it is the only job that does, and it is the CI-side canary.

**2. `npm init -y --prefix <dir>` IGNORES `--prefix` and writes package.json into the CWD.**
**Why:** running it from the repo root appended `main` + `directories` to ralphctl's own
package.json. In a release workflow that runs moments before `pnpm publish`, that is a corrupted
publish.
**How to apply:** in any pack/install smoke, write the stub by hand
(`printf '{"name":"…","version":"0.0.0","private":true}\n' > "$SMOKE"/package.json`) then
`npm install --prefix "$SMOKE" "$TARBALL"`. The stub is still load-bearing — with no package.json
at the prefix npm walks up and installs into the repo tree.

**3. `runCli` owns the CLI's terminal error frame** (`reportFatal` in `report-cli-error.ts`).
**Why:** `bootstrapCli`'s pre-flights throw plain `Error`s; uncaught they print a source excerpt
from the bundled `dist/cli-<hash>.mjs` plus a stack — worst on `doctor`, the command you run
because something is already broken. `AbortError` is HANDLED there (exit 130), deliberately not
re-thrown: the propagation rule targets mid-chain guards, and this is the last frame.
**How to apply:** stack stays behind `RALPHCTL_DEBUG_TRACE`. Settings validation messages render
compact `path: message` issue lists (`formatIssues`), never raw `ZodError.message` — the one-line
stderr frame is worthless if `<message>` is a 40-line JSON dump.

**4. `ralphctl prompts list` exists as a GATE, not a feature.**
**Why:** there are four independent copies of the beside-the-module bundle probe; `skills list` /
`agents list` / bundle-integrity walk three of them, and `fs-template-loader`'s copy falls back
SILENTLY to the package root. A `dist/prompts/` rename passes every old smoke green while all 21
prompt assets are unreadable (verified empirically). `prompts list` loads every body, so it exits 1.
**How to apply:** the inventory is `_engine/bundled-templates.ts`, fenced against the on-disk tree
by `tests/integration/ai/prompts/_engine/bundled-templates.test.ts` — a new prompt dir must join
the list or that test fails. `ci.yml` + `release.yml` grep `^implement` from its output.

**5. The pre-release tag glob and the npm `--tag` are ONE change, never separable.**
**Why:** Actions ref filters full-match and `[0-9]+` cannot express an optional suffix, so
`release.yml` needs a second literal pattern (`'v[0-9]+.[0-9]+.[0-9]+-*'`) or a `v0.20.0-rc.1` push
creates no run at all — silently, no error (that was #305; the `prerelease:` expression had been dead
since it was written). But widening the trigger alone is a live regression: `pnpm publish` had no
`--tag`, so an rc would land on `latest`, and `compareVersions`
(`src/business/version/version-check.ts`) strips pre-release suffixes on the _documented_ assumption
that `latest` is always stable — every stable user would be nagged to install the rc.
**How to apply:** the version step emits `npm_tag` (`next` when the version contains `-`, else
`latest`) and publish consumes it. The tag/version guard, changelog gate and pack smoke are all
string-based and already pre-release-safe — a pre-release still needs `package.json#version` and a
literal `## [0.20.0-rc.1]` changelog heading; that friction is deliberate. Fenced by
`tests/unit/ci/release-workflow.test.ts`, which also fences the PERFORMANCE.md release-procedure
prose against the workflow (the drift class #305 itself was). Untested until a real pre-release is
cut — if the glob still does not fire, fall back to one permissive `'v[0-9]+.[0-9]+.[0-9]+*'`.
