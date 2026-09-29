---
name: doctor-probes-and-escape-keys
description: Doctor auth probes never return fail; useViewKeys cannot match Escape/arrows; the demo seeder's marker-file safety rule
metadata:
  type: project
---

**Doctor auth probes return `unknown`, never `fail`.** `ProbeStatus` has `unknown` beside `pass/fail/warn`;
`allPassed` means "no fail and no warn" so unknown rows never flip it. Auth state is not reliably probeable:
claude-code's exit code is always 0 (parse the `{loggedIn}` JSON), copilot has no auth-status verb (never spawn),
opencode's free tier works with zero credentials (0 → unknown, not warn). **Why:** a false red on a working setup
is worse than an honest "can't tell". Shared probe builders live in `probe-helpers.ts` to avoid a cycle between the
group builder and the per-provider prober.

**`useViewKeys` cannot match Escape (or arrows, Home/End, PageUp/Down, F-keys, Backspace) via its `keys` array.**
Ink's `useInput` collapses `input` to `''` for all of them, so a string match can't tell them apart. Handle Escape
with a separate raw `useInput((_, key) => key.escape && …)` gated by the same `isActive`. Enter/Space stay literal
(`'\r'`, `' '`). Documentation-only `useViewKeys` entries (no `run`) exist for keys handled elsewhere.

**Global Escape ownership.** `use-global-keys.ts` pops the router on every Escape unless `ui.escapeClaimed`. A view
with its own Escape handler claims it via `useUiState().claimEscape()` in a `useEffect` (release on cleanup).

**Demo seeder.** `RunCommand` has no `cwd` option — use `git -C <dir>`. The `.ralphctl-demo` marker is written LAST
so a partial failure never leaves a wipe-safe-looking dir; reseeding refuses any existing dir without it.

**Lint is `--max-warnings 0`**; `sonarjs/cognitive-complexity` and `max-lines-per-function` are fatal. Extract
per-case helpers or a custom hook up front rather than after the fact.
