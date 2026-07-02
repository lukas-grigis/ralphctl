---
name: external-kill-escalation-seam
description: killWithEscalation shared SIGTERM→grace→SIGKILL helper for io runners; why it duplicates the provider-engine ladder; interactive-adapter abort seam + sonarjs 3-literal ratchet gotcha
metadata:
  type: project
---

Fix for the abort/kill-lifecycle defects in the integration layer (quality-sweep worktree).

**`src/integration/io/kill-with-escalation.ts`** is the shared SIGTERM→grace→SIGKILL helper for the
external-command runners (`run-cli.ts`, `run-command.ts`, `git-runner.ts`). It is an INTENTIONAL second
copy of the ladder already in the AI-provider engine (`_engine/abort-kill.ts` / `idle-watchdog.ts`,
`DEFAULT_GRACE_MS = 10_000`).

**Why:** `integration/io/` must not import the AI-provider `_engine/` (sibling-isolation); so the ladder
is re-expressed here rather than shared. The runners settle their result promise the instant the timeout
trips — a bare `child.kill('SIGTERM')` never reaped a wedged git/gh child that ignores SIGTERM (it could
hold `.git/index.lock` forever). `killWithEscalation` sends SIGTERM, schedules an `unref`'d SIGKILL after
the grace, and clears it on the child's `exit` so a recycled pid is never signalled. Promise semantics are
UNCHANGED — the escalation reaps in the background, resolution is not delayed.
**How to apply:** for any new external-process runner in `integration/io/`, kill via `killWithEscalation`,
not a bare SIGTERM. Test it with `vi.useFakeTimers()` + `advanceTimersByTime(grace)` (grace is injectable).

**Interactive AI adapters** (`providers/{claude,codex,copilot}/interactive.ts`): `attachAbortKill` was
DEAD CODE — no production caller threaded `abortSignal`. The 4 interactive leaf call sites
(`refine-ticket-interactive`, `call-planner-interactive`, `ideate-and-plan`,
`_shared/memory/distill-propose`) now forward `execute(input, signal)` → `interactiveAi.run({ abortSignal })`.
The adapters classify abort BEFORE the exit-code branch (mirrors `classifySpawnExit` step 1) so a
SIGTERM'd cancel surfaces `AbortError`, not `InvalidStateError`. See [[project_chain_runner_containment_boundary]].

**Lint ratchet gotcha:** these three interactive adapters' `run()` methods already sit over the
`max-lines-per-function` cap (pre-existing), and `sonarjs/no-duplicate-string` trips at 3 identical bare
string literals. Adding a 3rd occurrence of the provider-name literal (`'interactive-claude'` etc.) via a
new error's `elementName` introduced a warning — fixed with a module-level `const PROVIDER = 'interactive-<x>'`
reused for `entity` + `elementName`. When editing these files, reuse `PROVIDER`, don't re-type the literal.
