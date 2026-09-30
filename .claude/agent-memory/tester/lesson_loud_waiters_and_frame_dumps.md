---
name: lesson-loud-waiters-and-frame-dumps
description: TUI waits must throw on timeout; seed sentinels, control probes, and dump lastFrame() to a file
metadata:
  type: feedback
---

`tests/integration/application/ui/tui/_wait.ts` owns both waiters (`waitFor` assertion form, `waitForPredicate` boolean
form) and both throw on expiry. `_keys.ts` is key bytes and `tick` only. Never add a silent-timeout waiter or give two
waiters the same name: a silent timeout yields either a misleading downstream failure or a vacuously green test.
Pass a `label` to `waitForPredicate`; it is the failure message.

**Debugging:** vitest swallows `console.log` in this project. Dump `result.lastFrame()` to a file. When a
`waitForViewReady` extra predicate starts failing, suspect stale view COPY before timing.

**Flake fix pattern:** render a SEEDED sentinel that appears only once the seeding effect has committed and
`waitFor` it instead of `tick(50)`. For scroll clamps, wait on the tail/head line after PgDn/PgUp rather than a fixed
tick.

**"Empty is also the first frame":** a hook that seeds `[]` then fills after async work satisfies
`frame.includes('NONE')` at t=0. Render a control probe in the same tree that is guaranteed to resolve
(`CONTROL:<n>`), wait for `CONTROL:[1-9]`, add a grace tick, then assert over the WHOLE render history
(`seen.every(s => s.length === 0)`), not `seen.at(-1)`.
