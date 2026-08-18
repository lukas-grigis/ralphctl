---
name: release-gate-seams
description: Release/CI gate seams — vitest FORCE_COLOR pin, CLI terminal error frame, npm-pack prefix trap, and the prompts-list resolver gate
metadata:
  type: project
---

Four seams around the release/CI gates (hardened 2026-08-18, branch `chore/maintenance-hardening`).

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
