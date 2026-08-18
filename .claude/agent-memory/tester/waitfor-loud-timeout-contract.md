---
name: waitfor-loud-timeout-contract
description: TUI suite has ONE predicate waiter (waitForPredicate in _wait.ts) that throws on timeout; plus the settle-marker pattern for hooks whose "empty" state is also their first frame
metadata:
  type: project
---

# TUI async-wait helpers after the 2026-08-18 consolidation

**Fact.** `tests/integration/application/ui/tui/_wait.ts` owns BOTH waiters and both throw on
expiry (3000ms ceiling, 15ms poll, double-`setImmediate` settle):

- `waitFor(check: () => void | Promise<void>)` — assertion form; rethrows the last `expect` error.
- `waitForPredicate(predicate: () => boolean, { timeout?, interval?, label? })` — boolean form;
  throws `waitForPredicate: <label> never became true within Nms`.

`_keys.ts` is key bytes + `tick` ONLY. It used to export a same-named `waitFor` that `return`ed
silently on a 1000ms expiry; 36 files / ~200 call sites were migrated off it.

**Why:** a silent timeout produces either a misleading downstream failure or (when the wait _was_
the only check) a vacuously green test. Two such tests existed in `skills-view.test.tsx`.

**How to apply:**

- New polling waits use `waitForPredicate` and pass a `label` — the label IS the failure message.
- Never re-add a silent-timeout waiter, and never give two waiters the same name again.
- Flipping to loud immediately exposed two tests whose `waitForViewReady` extra-predicate had gone
  stale against renamed view copy (`'Display name'` → `Project display name`,
  `'Repository path'` → `Repository directory`). When a `waitForViewReady` extra predicate starts
  failing, suspect stale COPY first — dump `result.lastFrame()` to a file (vitest swallows
  `console.log` in this project) rather than guessing.

## Settle-marker pattern for "empty is also the first frame"

`useRunForensics` seeds `[]` and fills it after an async `fs.stat` pass, so
`waitFor(frame.includes('NONE'))` is satisfied at t≈0 — the negative tests asserted the PRE-effect
render. Fix (see `run-forensics.test.tsx`): render a **control probe** in the same tree that is
guaranteed to resolve and prints `CONTROL:<n>`; wait for `CONTROL:[1-9]`, add a small grace tick,
then assert over the WHOLE render history (`seen.every((s) => s.length === 0)`), not `seen.at(-1)`.
Any leak at any tick fails. Mutation-verified: negating the hook's `enabled` gate turns it red.

Related: [[gen-eval-turn-step-order-fence]], [[progress-overlay-flake-elimination]].
