# Workflows & State

> On-demand reference (split out of `CLAUDE.md`). Read when working on sprint lifecycle, planning,
> the implement gen-eval loop, or TUI navigation.

Sprint lifecycle: `draft → planned → active → review → done`, plus one recovery edge
`review → active` (unblocking a task on a review sprint — see below).

| Operation               | Draft | Planned | Active | Review | Done |
| ----------------------- | :---: | :-----: | :----: | :----: | :--: |
| Add / refine ticket     |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Plan tasks              |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Implement               |   ✗   |   ✓\*   |   ✓    |   ✗    |  ✗   |
| Review (apply feedback) |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |
| Close (review → done)   |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |

\*`plan` moves a draft sprint to `planned`; `implement` then activates it (`planned → active`) on first
launch, passing an already-`active` sprint through idempotently — a draft sprint must be planned first.
Implement transitions the sprint to `review` once every task has settled (`done` or `blocked`) AND at least
one task settled `done` — an all-blocked run stays `active` so the operator can fix the blocker and
re-run without backing the sprint out of review. The `sprint close` CLI command and the close-sprint flow
accept only `review`-status.

**Unblock reopens a review sprint (`review → active`).** A _mixed_ run (some tasks `done`, some `blocked`)
settles to `review`. Unblocking one of those blocked tasks (TUI `u` single / bulk, or `ralphctl task
unblock`) revives `todo` work — so `unblockTaskUseCase` reopens a `review` sprint back to `active`
(`revertSprintToActive` clears `reviewAt`, re-stamps `activatedAt`), re-arming the implement gate
(`planned` / `active` only) so the unblocked tasks get picked up on the next Implement run. The reopen is
best-effort and idempotent: a non-`review` sprint passes through untouched, and a reopen that fails to
persist is logged without failing the unblock (re-running unblock retries it — the already-`todo`
short-circuit still reopens). Without this, an unblocked task on a review sprint would be stranded:
Implement is gated out and only Review / Close remain.

**Two-phase planning.** **Refine** (`refine` chain) is implementation-agnostic per-ticket clarification —
no repo exploration; ticket `requirementStatus` flips `pending → approved`. **Plan** (`plan` chain) requires
every ticket `approved`; repo selection runs inside the chain and persists on `Sprint.affectedRepositories`
(absolute paths); AI generates `tasks.json` atomically and the sprint transitions `draft → planned`.
**Ideate** combines both in a single AI session for low-stakes work.

**Per-task generator-evaluator** inside `implement` uses the `loop` primitive. The gen-eval loop body is
`generator-leaf → evaluator-leaf` (looped up to `maxTurns` per attempt, stopping when the evaluator sets
`ctx.lastExit`). Each attempt then runs `settle-attempt` (which records the verdict) plus `append-learnings`
and `progress-journal`; the outer attempt loop re-enters up to `maxAttempts` times per task and transitions
the task to `blocked` once that budget is exhausted. A single launch now runs the outer attempt loop up to
`maxAttempts` times per task — `maxAttempts === 1` is byte-for-byte the prior single-attempt behaviour.
`settings.ai.implement` is a nested
`{ generator, evaluator }` pair — each role carries its own `{ provider, model, effort? }` row, so
the two sessions can run on different providers / models / effort levels (effort resolution rules
described in `AI-SETTINGS.md` apply per-row). Default: generator runs `claude-code` /
`claude-opus-4-8`, evaluator runs `openai-codex` / `gpt-5.5` — deep-coder reasoning on the produce
side, an independent reviewer on the score side. Every other flow (`refine` / `plan` / `readiness` /
`ideate` / `createPr`) keeps the flat `{ provider, model, effort? }` row shape; the analogous
generator-evaluator split for the `plan` flow is deferred to future work.

**Gen-eval settle semantics.** Every non-passing exit from the gen-eval loop is now routed through the
escalation policy and the attempt budget before settling. `plateau` and `budget-exhausted` exits
consult `decideEscalation` — escalate/nudge fail the running attempt so the outer loop re-enters on the
stronger model; topped-out and attempt-budget-exhausted keep the work (done-with-warning). `malformed`
exits (evaluator failure) get a plain same-model fresh-attempt retry (no ladder rung) while budget
remains. `done-with-warning` is reserved for true exhaustion of remedies (all attempts spent, no rung
remaining, or `escalateOnPlateau === false`). A task that truly exhausts all remedies is never silently
dropped — the `done-with-warning` outcome is surfaced in the sprint journal, the PR, and the TUI. See
`PERFORMANCE.md § Escalation on plateau` for the full routing rules.

**Pre-blocked task skip.** When `pre-task-verify` returns a block decision (non-interactive hard-block
or operator "skip"), it stamps `lastExit = { kind: 'self-blocked', reason }` on ctx. The gen-eval
loop's `shouldStop` predicate fires immediately and no generator or evaluator turn runs. A zero-turn
guard also skips the post-task verify when `lastExit` is already set on ctx entry, avoiding a spurious
verify run on a tree the generator never touched.

**Serial-path blocked-diff quarantine.** On the serial path, when a task is blocked (own-failure),
its rejected diff is stashed to `ralphctl/<sprintId>/<taskId>/blocked-diff` and recorded on
`blockedReason` before sibling tasks run — preserving the rejected work for post-mortem inspection
without contaminating subsequent tasks' working trees. Intermediate commits from earlier green-verify attempts of a later-blocked task remain on the sprint branch by design — each passed its own verify; only the final blocked attempt’s uncommitted diff moves to the stash.

**Legacy `implement` promotion.** Settings files written by ralphctl ≤ 0.7.0 stored `ai.implement`
as a flat `{ provider, model, effort? }` row. Such files are silently promoted at load time into the
nested shape, with `generator` and `evaluator` both set to a copy of the legacy row — no
`schemaVersion` bump and no user-facing notice. The next `save()` rewrites the file in the canonical
nested shape, so the promotion fires at most once per file.

**TUI is the primary surface.** From Home: pipeline-map quick-actions + browse submenu (Sprints / Tickets /
Tasks / Projects). Multi-flow navigation: Tab / Shift+Tab cycle running flows, `Ctrl+1..9` direct-jump to
the Nth running flow — both operate over RUNNING sessions only and are suspended while a prompt / overlay is
mounted; `SessionsView` lists every runner. `Ctrl+1..9` only fires under a kitty-keyboard-protocol terminal
(iTerm2 / kitty / WezTerm / foot) — Ink surfaces `key.ctrl` for digits only via the CSI-u extension; in other
terminals it is an inert no-op (the help overlay labels it accordingly), while `Tab` cycling works everywhere.
`?` opens the centralised help overlay generated from `keyboard-map.ts`.

Execute view: three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail at `md` (100–139),
single-column below `md`. Rail grows fluidly 36→56 cols at `xl`+ via `resolveRailWidth`. Named breakpoints
(`sm 80 / md 100 / lg 140 / xl 180 / xxl 220`) are canonical — use `breakpointFor`, `fluid`, `responsive`,
`useBreakpoint` from `theme/tokens.ts`; no hardcoded column literals. Global keys: `b` banner, `g` progress,
`y` yank, `P` project picker, `S` sprint picker. Execute-view: `j`/`k` nav, `e` verification-criteria, `c` cancel-scope.

**`setupScript` vs `verifyScript`.** Setup runs unconditionally once per affected repo at sprint start;
each attempt is recorded as a structured `SetupRun` (outcome: `success` / `failed` / `spawn-error` /
`skipped`) persisted on `SprintExecution.setupRanAt`. Non-zero exit or spawn failure hard-aborts the
chain. Verify runs both **pre-task** (before the AI) and **post-task** (after commit) with an attribution
algorithm (`clean` / `regressed` / `baseline-broken` / `fixed-baseline`) that avoids blocking the AI for
pre-existing failures. Failure transitions the task to `blocked`, never `done`. `Repository.verifyTimeout`
caps both the pre- and post-task verify calls as `timeoutMs` on the shell runner; when absent the runner
falls back to `DEFAULT_SHELL_TIMEOUT_MS` (5 min). Both scripts are collected during `detect-scripts` and
persisted on `Repository.{setupScript,verifyScript,verifyTimeout}`. Persisted `project.json` files written
before v0.7.0 used `checkScript` / `checkTimeout`; the schema accepts those legacy keys on read and
rewrites the canonical names on the next save (no manual migration step).

**Branch management.** `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
per-task preflight verifies the right branch. `ralphctl create-pr --sprint <id>` opens PR / MR via `gh` /
`glab` and persists `SprintExecution.pullRequestUrl`.
