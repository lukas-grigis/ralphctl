---
name: project_trustworthy_firstrun_waves12_2026-08-14
description: Feature C Waves 1-2 (honest doctor auth probes, welcome keypress gate, ralphctl demo) — key gotchas for anyone touching doctor/ or the demo seeder next
metadata:
  type: project
---

Implemented 2026-08-14 on branch `feature/plan-checks-conformance-first-run` (part of a 3-agent
parallel council-feature session; Wave 3 — scripted transcript, wire.ts/launcher.ts spawn
threading — was a SEPARATE agent's scope, not covered here).

**Doctor `unknown` status (Wave 1).** Added `'unknown'` to `ProbeStatus` alongside `pass/fail/warn`.
`DoctorReport.allPassed` redefined as "no fail and no warn" so unknown rows never flip it;
`hasFailures` untouched (fail-only). `probeProviderAuth` (new `flows/doctor/provider-auth.ts`)
never returns `'fail'` — worst case `'warn'`. Per-provider auth mechanism table: claude-code
parses `{loggedIn, authMethod}` JSON off `claude auth status` (exit code is NOT the signal —
always 0 either way); openai-codex keeps the pre-existing exit-code semantics of
`codex login status` (logged-out path is UNVERIFIED live — only logged-in was probeable);
opencode parses an "N credentials" tail off `providers list` (N=0 → unknown, not warn — free
tier works with zero); github-copilot has no auth-status verb at all → `kind: 'none'`, never
spawns. Shared `mkProbe`/`PROVIDER_LABEL` builders live in a new `probe-helpers.ts` (NOT in
`probe-groups.ts` or `provider-auth.ts` directly) specifically to avoid a two-file import cycle
between the group-builder and the per-provider prober — both consume the helpers file instead of
each other.

**`useViewKeys` cannot match Escape (or any arrow/fn/backspace key) via its `keys` array.** Ink's
`useInput` collapses `input` to `''` for ALL of: Escape, arrows, Home/End, PageUp/Down, F-keys,
Backspace (see `ink/build/hooks/use-input.js` — `nonAlphanumericKeys.includes(keypress.name) →
input = ''`, and bare-ESC's sequence also strips to `''`). So a `useViewKeys` binding matching on
`input` (like `['\r', ' ']` for Enter/Space — these DO stay literal) can never distinguish Escape
from any other special key if you naively add `''` or the string `'esc'` to `keys`. Handle Escape
via a separate raw `useInput((_, key) => key.escape && …)` call instead, gated with the same
`isActive` condition. Precedent for "documentation-only, no `run`" `useViewKeys` entries (e.g.
`{ keys: ['↵'], hint: 'open' }`) exists precisely because real Enter-handling in list views
happens through `key.return` in a different primitive, not through this dispatcher's string match.

**Global Escape ownership**: `use-global-keys.ts`'s `router.pop()` fires on every Escape unless
`ui.escapeClaimed` — claim it locally via `useUiState().claimEscape()` in a `useEffect` (release
on cleanup) whenever a view-local Escape handler needs exclusive ownership, mirroring
`implement-main-area.tsx` / `sprint-detail-internals/detail-body.tsx`.

**`ralphctl demo` / `src/application/demo/seed.ts`**: `RunCommand` (`integration/io/run-command.ts`)
has NO `cwd` option — git ops go through `-C <dir>` args instead (same pattern as the existing
`probeProjectDefaultBranches` doctor probe). `seedDemoWorkspace` is a pure-ish helper (Result-typed,
`unwrap`-throws-DomainError internally, caught at the boundary) shared by `scripts/seed-mock.ts`
(`pnpm mock`, unchanged CLI UX, package.json untouched per orchestrator ruling) and the new
`demo` CLI command — the `.ralphctl-demo` marker file (written LAST, after all domain writes, so a
partial failure never leaves a wipe-safe-looking marker) is what makes `ralphctl demo --home <dir>`
safe to reseed: refuses any existing dir lacking the marker, never wipes an unrelated directory.

**Lint is `--max-warnings 0`** (not the 1-warning historical baseline some older memories cite) —
`sonarjs/cognitive-complexity` and `max-lines-per-function` are BOTH fatal, not advisory. New
switch-per-kind functions and any React hook doing seed+route+keypress-gate work in one component
will trip these; extract per-case helpers / a custom hook immediately rather than after the fact.
