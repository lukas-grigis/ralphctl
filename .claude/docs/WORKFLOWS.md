# Workflows & State

> On-demand reference (split out of `CLAUDE.md`). Read when working on sprint lifecycle, planning,
> the implement gen-eval loop, or TUI navigation.

Sprint lifecycle: `draft → planned → active → review → done`, plus two recovery edges:
`review → active` (unblocking a task on a review sprint) and `done → review` (reopening a closed
sprint — automatically when unblocking a task on it, or explicitly via `ralphctl sprint reopen
<id>`). `done` is terminal only for the automated chains — no chain leaf mutates a `done` sprint
further — never for the operator: see "Unblock" below.

| Operation               | Draft | Planned | Active | Review | Done |
| ----------------------- | :---: | :-----: | :----: | :----: | :--: |
| Add / refine ticket     |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Plan tasks              |   ✓   |    ✗    |   ✗    |   ✗    |  ✗   |
| Implement               |   ✗   |   ✓\*   |   ✓    |   ✗    |  ✗   |
| Review (apply feedback) |   ✗   |    ✗    |   ✗    |   ✓    |  ✗   |
| Close (review → done)   |   ✗   |    ✗    |   ✗    |   ✓†   |  ✗   |
| Reopen (done → review)  |   ✗   |    ✗    |   ✗    |   ✗    |  ✓‡  |

\*`plan` moves a draft sprint to `planned`; `implement` then activates it (`planned → active`) on first
launch, passing an already-`active` sprint through idempotently — a draft sprint must be planned first.
Implement transitions the sprint to `review` once every task has settled (`done` or `blocked`) AND at least
one task settled `done` — an all-blocked run stays `active` so the operator can fix the blocker and
re-run without backing the sprint out of review.

†`review → done` has two doors — the explicit `close-sprint` flow (`sprint close` CLI, or the TUI's
`n → close-sprint`) and the review flow's own auto-done path (empty / repeat feedback round settles
the loop) — and both now confirm before crossing it rather than closing in silence. Each loads the
sprint's tasks and, if any are `blocked`, asks the operator to confirm, naming them
(`confirmBlockedTasksLeaf` — a shared leaf at `application/flows/_shared/task/confirm-blocked-
tasks.ts` that `review`'s chain composes, and an equivalent one local to `close-sprint/leaves/` for
that flow). This is confirm-and-proceed, never a refusal: closing with blocked work left behind is a
legitimate call — informally "descoping" the remainder — and declining raises an `AbortError` that
stops the chain before the transition leaf runs, leaving the sprint `review` and re-runnable.
`launchCloseSprint`'s own pre-flow "close this sprint?" prompt folds the same count in too, so a
blocked task is named before AND during the close. The CLI has no `InteractivePrompt` to drive the
in-chain gate, so `sprint close <id>` runs an equivalent confirm of its own (`-y`/`--yes` to skip
it) and, once the close lands, prints which tasks stayed blocked regardless of whether `--yes`
skipped the prompt.

‡`done` is not a dead end: unblocking a task on a closed sprint means there is runnable work again,
and the implement gate only re-arms for `planned` / `active`. `reopenDoneSprint`
(`domain/entity/sprint.ts`) is the one deliberate exit from `done`, landing in `review` — not
`active` — so the existing `review → active` step (`revertSprintToActive`, see "Unblock" below)
carries it the rest of the way instead of the sprint gaining a second, parallel `done → active`
transition to keep in sync with.
Reached two ways: automatically, as the first hop of `unblockTaskUseCase`'s own reopen when the
unblocked task's sprint is `done`; or explicitly via `ralphctl sprint reopen <id>` (idempotent — an
already-`review` sprint prints "nothing to reopen" rather than erroring). Both paths enforce the
single-active-per-project invariant (`assertNoActivePeer` — a different sprint on the same project
already holding `active` or `review`): the explicit CLI path refuses with a `ConflictError`, while
the automatic hop inside unblock calls that same helper and treats a conflict as data — the
task is still revived, the sprint stays `done`, and the conflict rides out on
`UnblockTaskOutput.sprintReopenConflict` so the CLI can name the peer and the `sprint close` that
releases it (then `ralphctl sprint reopen <id>` + another unblock finishes the job). Every other
failure on that hop is part of the unblock: the `done → review` write runs BEFORE the task write, so
a failed sprint load, peer-list read or persist fails the unblock with the task untouched, and a
failed task write puts the sprint back to `done` — a plain retry starts over.

**Unblock — the operator's recovery path.** A task blocks when its own attempt budget or verify
gate exhausts (`blocked`, `blockKind: 'own'`) or when a prerequisite it depends on never finished
(`blocked`, `blockKind: 'upstream'` — see `upstreamBlockedDependents`); the same `u` recovery hatch
also resets a task left `in_progress` by a prior crash (`resetTaskToTodo`, which — unlike a real
unblock — preserves its attempts because it resumes mid-work rather than restarting). The moment
`settleAttemptUseCase` persists a task as `blocked` it publishes a `TaskBlockedEvent`
(`business/observability/events.ts`); `notification-subscriber.ts` classifies it `attention`,
raising the operator banner and (when `settings.ui.notifications.enabled`) the OS notification — a
block is never a silent event.

Blocked work is then visible everywhere an operator orients: the Home active-sprint card and the
settled-run summary both add a `· N blocked` count beside the pending count (a sprint whose entire
remainder was blocked used to read as "0 tasks pending" — nothing left to do); the Sprints list
carries a `N blocked` badge per sprint and the cross-project sprint picker shows the same count on the
focused row (both batch-loaded via `loadTaskHealthBySprintId`,
`application/ui/shared/state-snapshot.ts`); sprint-detail's header and
its `NextPhaseCard` name the blocked tasks and switch to a warning presentation instead of the dim
all-clear checkmark, even once the sprint is `done`; and the Execute view's Tasks panel anchors its
post-run card cursor and auto-expansion on the first `blocked` task rather than the last one, so a
blocked card is never left windowed off-screen behind an overflow cue the instant a run settles.

Acting on it: the Tasks panel and sprint-detail both bind `u` to unblock the FOCUSED card's stuck
task (`tasksPanelKeys.unblock` / `contextualKeys.unblockTask`); the Sprints list binds `u` to
bulk-unblock every stuck task in the focused sprint; sprint-detail additionally binds `B` to jump
the cursor straight to the next blocked task (wrapping), so a long ticket + task list never needs
arrowing past blind. On the CLI, `ralphctl task list` prints a blocked entry's reason, the
generator's own triage when its signal supplied one (`blocker:` / `question:` / `unblocks with:`),
and a `recover with: ralphctl task unblock <id>` footer; `ralphctl sprint progress` groups blocked
tasks by root cause (an upstream cascade collapses under the task that actually failed, instead of
N equal-weight rows); and `ralphctl task unblock <id>` is the recovery command itself.

Every path funnels through `unblockTaskUseCase` (`business/task/unblock-task.ts`): a clean restart
that strips the block fields and resets the attempt budget to empty. Not a silent reset, though —
the cleared attempts, per-criterion verdicts, and escalation stamps are ARCHIVED onto
`Task.retiredAttempts` (oldest first — `domain/entity/task-lifecycle.ts`'s `unblockTask`) rather
than discarded, so the fresh run gets a full attempt budget back while the forensic record survives
(`foldOutcomeStats` folds a retired run's attempts back into the outcome report same as the live
ones). Unblocking one task also cascades: every task the dependency gate parked upstream of it
(`upstreamBlockedDependents`) re-arms to `todo` in the same transaction — an own-failure block in
that subtree is left untouched, since that one needs a real fix, not a cascade. And unblocking
re-arms the SPRINT, not only the task: a `review` sprint reopens to `active` (`revertSprintToActive`
clears `reviewAt`, re-stamps `activatedAt`) and a `done` sprint reopens through `review` first (see
the reopen footnotes above) before that same `review → active` hop runs on top of it. Only the
`review → active` hop is best-effort: it runs after the task write, a failed persist is logged, and
the next unblock call (the already-`todo` short-circuit) retries it. That short-circuit never reopens
a `done` sprint — a closed sprint holding `todo` work was closed that way on purpose. Every reopen an
unblock performs is reported on `UnblockTaskOutput.sprintReopened`, and the CLI / TUI say so.

The rejected diff survives the block too. When a task settles `blocked` after at least one gen-eval
turn ran, its uncommitted diff is stashed under a deterministic message keyed on sprint + task
(`quarantineStashMessage` → `ralphctl/<sprintId>/<taskId>/blocked-diff`) before the tree is handed
onward — see "Blocked-diff quarantine & restore" below for the git-level mechanics on both the
serial and parallel implement paths, including why a blocked worktree's branch ref is kept rather
than deleted, and how a later attempt restores it by that same message key.

The generator's own structured triage for a self-block — `blockerClass` (`missing-information` /
`ambiguous-request` / `contradictory-information`), the concrete `question` it needs answered, and
`whatUnblocksMe` — rides from its `task-blocked` signal onto the persisted `BlockedTask` whenever
the signal supplied it (all three are optional; a legacy or minimal signal still blocks the task
via `reason` alone) and surfaces in both the Tasks panel overlay and `ralphctl task list`.

**Two-phase planning.** **Refine** (`refine` chain) is implementation-agnostic per-ticket clarification —
no repo exploration; ticket `status` flips `pending → approved`. **Plan** (`plan` chain) requires
every ticket `approved`; every project repository is mounted as an equal `--add-dir` root, and repo
selection lands per task as `Task.repositoryId` (resolved against `project.repositories`) — the sprint
itself stores no repo list; AI generates `tasks.json` atomically and the sprint transitions `draft → planned`.
**Ideate** combines both in a single AI session for low-stakes work.

**Plan's approval gate is split from the AI hand-off.** `call-planner-interactive` stops at the proposal
(`ctx.proposedTasks`) — it no longer runs the `draft → planned` transition itself. A zero-token,
deterministic `check-plan` leaf (`business/sprint/check-plan.ts`) runs next: an infallible fold over the
proposal that catches task-graph faults, an unknown repository, missing verification criteria, a missing
`auto` command, a placeholder / prose / multi-line command, or a duplicate criterion id, tiered `error` /
`warning`. Findings are advisory — they never fail the chain, and are rendered above the "Approve plan?"
prompt for the operator to read before deciding. `apply-plan` then owns the HITL `reviewBeforeApprove`
gate (now takes the findings as a third argument) and the `draft → planned` transition. Both new leaves sit
AFTER `uninstall-skills`, so the skills sandbox is torn down before a potentially long human pause at the
gate. Full chain: `… render-prompt-to-file → install-skills → stamp-meta-plan → call-planner-interactive →
uninstall-skills → check-plan → apply-plan → save-tasks → save-sprint` (fenced by
`tests/unit/application/flows/plan/flow-shape.test.ts`).

**Reproduction-first leaf.** Before the attempt loop, `per-task-subchain.ts` runs an unconditional reset
(`clearReproductionArtifactLeaf`) followed by a guard testing `isDefectShapedTask` (task kind `bugfix`,
once per task, not per attempt). When it fires, `reproduceLeaf` spawns a one-shot headless session that
writes and runs one failing test demonstrating the reported defect; the harness re-runs the claimed
command itself and only accepts the artifact (`ctx.reproductionArtifact`) when that re-run actually
fails — a reproduction that passes proves nothing. The validated test path, run command, and the
session's own list of relevant existing tests then ride into every generator and evaluator turn of that
task's gen-eval loop via the `<reproduction>` prompt section. A failed session, an invalid signal, or a
claimed command that turns out to pass on re-run all degrade silently to today's behaviour — no
reproduction context, task proceeds unaffected. The accepted artifact is also saved to
`implement/<task-id>/reproduce/artifact.json`. On a relaunch whose earlier work is still quarantined
(see "Blocked-diff quarantine & restore" below), the leaf never spawns a second session: it adopts the
saved reproduction, or continues without one when nothing was saved, since the failing test it would
otherwise write is already part of the quarantined diff.

**Per-task generator-evaluator** inside `implement` uses the `loop` primitive. Each gen-eval turn runs
`generator-leaf` then — if the generator did not already set `ctx.lastExit` — the guarded
`evaluator-step`, a `sequential` of `evaluatorLeaf → loop-diversity-check → entropy-check`. The two
plateau-check leaves each emit a `plateau` exit on ctx, both windowed by the SAME `plateauThreshold`
knob the calibrated predicate uses and both gated on `windowIsHardStall` (so neither fires earlier than
the operator asked for, nor overrides the critique-shift / work-product exemptions):
`loop-diversity-check` fires when the failed-dimension fingerprint repeats across the whole window;
`entropy-check` (opt-in — `harness.entropyPlateauDetector`, default off) fires when the normalised
Shannon entropy over the generator's signal-kind distribution (decision / change / learning / note),
pooled across the window, falls below 0.25 — a heuristic proxy for approach stagnation, not raw
tool-use entropy. Both respect the turn-budget-precedence guard so neither pre-empts the final
budgeted turn. The loop exits when any leaf sets `ctx.lastExit` or the `maxTurns`
budget is reached. Each attempt then runs `settle-attempt` (which records the verdict) plus
`append-learnings` and `progress-journal`; the outer attempt loop re-enters up to `maxAttempts` times
per task and transitions the task to `blocked` once that budget is exhausted. A single launch runs the
outer attempt loop up to `maxAttempts` times per task — `maxAttempts === 1` is byte-for-byte the prior
single-attempt behaviour.
`settings.ai.implement` is a nested
`{ generator, evaluator }` pair — each role carries its own `{ provider, model, effort? }` row, so
the two sessions can run on different providers / models / effort levels (effort resolution rules
described in `AI-SETTINGS.md` apply per-row). Default: generator runs `claude-code` /
`claude-opus-5-5`, evaluator runs `openai-codex` / `gpt-6-sol` — deep-coder reasoning on the produce
side, an independent reviewer on the score side. Every other flow (`refine` / `plan` / `readiness` /
`ideate` / `createPr`) keeps the flat `{ provider, model, effort? }` row shape; the analogous
generator-evaluator split for the `plan` flow is deferred to future work.

**Best-of-N rung.** When `settings.harness.bestOfNCandidates` is `2`-`4` (default `2` — on; the four
`*-economic` presets pin it to `0` to opt out) and the escalation policy grants the once-per-task
`best-of-n` remedy (see "Gen-eval settle semantics" below), the
granted attempt's round 1 REPLACES the normal generator step with a candidate-sampling composite
(`buildBestOfNGenEvalLoop`): sample N candidates on the unchanged model, discard `regressed`-attribution
candidates, dedupe identical diffs by content hash, then — for 2+ survivors — a pairwise judge tournament
over the candidates' compact structured summaries (never raw diffs) picks the winner, whose diff is
applied. Round 1's evaluator turn (and any round 2+, only reached if round 1 didn't reach a terminal
verdict) runs exactly the same `evaluatorLeaf` sequence every other attempt uses — no bespoke settle
logic. Every other attempt of the task, before and after the granted one, takes the normal
`createGenEvalLoop` path unchanged.

**Gen-eval settle semantics.** Every non-passing exit from the gen-eval loop is now routed through the
escalation policy and the attempt budget before settling. `plateau` and `budget-exhausted` exits
consult `decideEscalation` — escalate/nudge fail the running attempt so the outer loop re-enters on the
stronger model (a model-rung `escalate` also carries the evaluator's own lockstep effort bump, when it
has headroom); a plateau at the top of the ladder, already nudged, grants the opt-in `best-of-n` rung
once per task when configured; topped-out and attempt-budget-exhausted keep the work (done-with-warning).
`malformed`
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

**Corrective-retry gate before self-block.** When a generator or evaluator spawn exits without a
valid `signals.json` (signals-missing / invalid-json / schema-mismatch — a correctable contract
failure), the harness does not self-block immediately: it issues up to `settings.harness.correctiveRetries`
(1–5, default 2) bounded in-round nudges, each a full resumed spawn re-prompted with the concrete
fix, before giving up. Only after every nudge still fails does the turn stamp a `self-blocked` exit.
These nudges are in-round and consume no `maxTurns`/`maxAttempts` budget; a self-blocked exit still
never retries at the task level. See `contract/_engine/corrective-retry.ts`.

**Blocked-diff quarantine & restore.** When a task settles `blocked` after at least one gen-eval turn
ran, its rejected uncommitted diff is stashed under the deterministic message
`quarantineStashMessage(sprintId, taskId)` (`ralphctl/<sprintId>/<taskId>/blocked-diff`) via
`runQuarantineBlockedDiff` (`implement/leaves/quarantine-blocked-diff.ts`), and the stash message is
recorded onto the persisted `blockedReason` plus appended to `progress.md` (an operator unblock is a
clean restart that strips `blockedReason`, so the journal line — not the task field — is the durable
recovery pointer). Both implement paths call the same function: the serial path splices it in-chain,
guarded on the settled task actually being `blocked` with a real AI turn behind it (so a dependency-
gate skip, or a pre-task-verify hard-block with no AI diff, never triggers a spurious stash), so the
SHARED serial worktree is clean before the next task's subchain runs — without it, a later task's
`git add -A` would sweep the earlier rejected diff into its own commit, flip its pre-verify red, and
land a corrupt commit mis-attributed `baseline-broken`. The parallel path calls it directly from
`wave-branch.ts`'s per-worktree teardown, `cwd` pointed at the worktree (which shares `.git` with the
main repo, so the stash survives the worktree's removal), BEFORE `git worktree remove --force` —
previously that removal silently destroyed a rejected diff with nothing quarantined first. The
worktree's branch ref is also kept rather than deleted on cleanup whenever the task ended `blocked`
OR the branch never completed its fold (an abort — or a throw — landing between the subchain settling
`done` and the fold step): a fold-conflict block means the worktree's commits are real and landed on
that ref and nowhere else, and an interrupted fold leaves already-verified commits equally ref-only
while the epilogue rewrites the task back to its pre-wave status, so removing the ref would strand
that work in the reflog until GC. An own-failure block's ref may hold nothing of value, but keeping
it uniformly is cheap. The keep is a recovery WINDOW, not permanence, and the window is one launch
wide: `setupWorktree` force-deletes the ref (`git branch -D`) the next time THAT task starts — for a
blocked task, the first relaunch after the operator unblocks it. Past that point the commit survives
only as a SHA — and where depends on the reason for the keep. A blocked task's SHA is in `tasks.json`
either way: whether the branch's own runner reached `completed` (a fold conflict — `captureDurableFold`
records the settled task directly) or it errored / aborted right after a leaf had already saved the
block to disk (a resume-budget exhaustion, or a settle-then-abort) — the epilogue's
`adopt-persisted-blocks` step re-reads that persisted row, stash pointer included, before
`saveTasksLeaf` writes the run's task list, so a non-`completed` branch's block is recovered rather than
overwritten with its pre-wave copy (an unblock still archives the attempts into `retiredAttempts` rather
than deleting them). It's also on `progress.md`'s `- Commit: <sha>` line. An interrupted fold's SHA is on
`progress.md` ONLY: an aborted branch never emits `completed`, so `captureDurableFold` skips it and the
epilogue's `saveTasksLeaf` rewrites the task back to its pre-wave copy, clobbering the attempt row that
held `commitSha`. Either still feeds a manual `git cherry-pick` until gc prunes the object.
Intermediate commits from earlier green-verify attempts of a later-blocked task remain on the sprint
branch by design — each passed its own verify; only the final blocked attempt's uncommitted diff moves
to the stash. The wave's fan-in itself only ever updates the ONE task a branch actually settled (never a
branch's whole task list), so one branch failing mid-wave can no longer revert an already-`done` sibling
the same wave already completed back to `todo`.

On the task's next attempt — a relaunch, or a same-run retry within budget — `restore-blocked-
diff.ts` looks the stash up by that SAME message key (never a raw stash index) and pops it back, so the
retry builds on the prior diff plus the evaluator's critique instead of starting from zero. The pop runs
AFTER `pre-task-verify`, and only when pre-task-verify actually let the attempt through (guarded on no
terminal exit being set yet): the baseline must measure HEAD, not HEAD plus a diff that was already
rejected once, and a diff popped ahead of a hard pre-verify block would sit in the tree with zero AI
turns behind it — too early for the block to re-quarantine it (see "Pre-blocked task skip" above), so
before this reordering that diff was lost to the parallel teardown or the next task's `git add -A`.
Matching by message, not position, matters because the parallel path can push/list/pop several
worktrees' stashes concurrently against the ONE `refs/stash` ref every worktree shares with the main
repo; `gitStashPush` / `gitStashList` / `gitStashPop` (`integration/io/git-operations.ts`) are funnelled
through an in-process FIFO mutex so a sibling's concurrent push can never shift the index a pop is about
to act on out from under it. A missing stash is a silent no-op and a failed pop never fails the attempt —
restoration is a convenience, not a correctness requirement. The leaf only pops onto a tree that
`git status --porcelain --untracked-files=normal` reports clean — `gitStashPush` and every dirty-tree
check in the flow already read through `gitStatusPorcelain`, which itself now passes that same flag, so
this probe's own `--ignore-submodules=none` is the only override still specific to it. A tree can
legitimately be dirty here: changes the operator kept at the dirty-tree prompt, non-ignored setup
output, or artifacts a verify script left behind — none of that sits in any stash, so on a dirty tree (or
a failed probe) the stash is left in place and its message logged. A pop that FAILS is not left
half-applied, though: git keeps the stash entry but can still write a `<<<<<<<`-marked merge or part of
the diff into the tree, so the leaf re-probes and, when the tree changed, resets it to HEAD
(`reset --hard HEAD` + `clean -fd`, which also drops the untracked files a `-u` stash restores) — an
exact undo, since the tree was clean a moment before. Without that, the generator would build on a
half-merged tree and `commit-task`'s `git add -A` could commit conflict markers whenever the verify gate
doesn't catch them. Either way the diff stays recoverable by hand via `git stash list`. On a relaunch
that reuses a saved reproduction (see "Reproduction-first leaf" above), the leaf also re-checksums that
reproduction's test once the pop has settled. A match keeps the artifact as-is. A mismatch is KEPT —
with the evaluator's tamper note, so it re-runs the reproduction and reports the tampering — when the pop
itself restored a change to that test (an earlier launch weakened it before blocking, and this launch
continues that work); it is DROPPED only when the test genuinely isn't in the tree: missing, unreadable,
or the committed copy because the pop was skipped, undone, or restored an entry that never touched it
(the reproducer prefers adding its case to an existing test file, so the committed copy is common). With
no matching stash at all, ctx is left alone — an edit to the test during this launch is the evaluator's
to flag, not this leaf's to hide.

An interrupted PARALLEL branch (Ctrl-C, an error, a throw) that popped this stash but then never
committed and never re-blocked the task leaves the restored diff sitting only in the worktree, with no
other copy — the pop already dropped the stash entry. Each worktree branch snapshots, before the
worktree itself exists, HOW MANY stash entries its task's key holds (a count, not a boolean — the key can
hold more than one: a failed pop keeps its entry, and the block that attempt then reaches quarantines a
second diff under the same message). At teardown, when the task's last opened attempt committed nothing
and that count has DROPPED versus the branch-start snapshot — an attempt popped an entry and never put it
back — the teardown pushes the worktree's changes back under the same message before removing it, even
when an older entry under the same key is still listed in the stash (an older entry still being there
proves nothing about the one that left; the count is exact because nothing else touches this key while
the branch runs). When that re-stash itself can't be confirmed, the worktree (and its ref) is kept on
disk instead — the same fail-safe "leave it for inspection" the unreadable-task-state case already uses.

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

**Customize picker's skills step + Skills catalog view.** The pre-launch customize picker (per AI flow:
`Start` / `Customize for this run…` / `Cancel`) gained a skills step after the provider/model/effort row
walk(s) — a checklist pre-checked to what would currently load, then `Apply for this run only` vs `Apply
and remember for <flow>` (remember persists only the flow's registry-default names into
`settings.ai.skills[flow].disabled`, merge-preserving hand-added entries — project / operator /
phase-folder unchecks stay run-scoped; see `AI-SETTINGS.md`). Skipped entirely for a flow with no AI
row, no skill candidates to offer, or a degraded (partially failed) candidate listing. The Home
menu's `Skills catalog` view (hotkey `K`) is the enable / disable / update surface across every flow's
opt-in phase folder: `e` enable, `d` disable, `u` update one, `U` update every out-of-date copy, `r`
reload — the filesystem under `<appRoot>/skills/<flow>/` is the source of truth (see `ARCHITECTURE.md`
§ Skills subsystem).

Execute view: three-column at `xl` (≥180), two-column at `lg` (≥140), compact-rail at `md` (100–139),
single-column below `md`. Rail grows fluidly 36→56 cols at `xl`+ via `resolveRailWidth`. Named breakpoints
(`sm 80 / md 100 / lg 140 / xl 180 / xxl 220`) are canonical — use `breakpointFor`, `fluid`, `responsive`
from `theme/tokens.ts` and `useBreakpoint` from `runtime/use-breakpoint.ts`; no hardcoded column literals.
Global keys: `b` banner, `g` progress,
`y` yank, `P` project picker, `S` sprint picker. Execute-view: `j`/`k` nav, `e` verification-criteria, `c` cancel-scope.

**`setupScript` vs `verifyScript` / `verifyGates`.** Setup runs unconditionally once per affected repo at
sprint start; each attempt is recorded as a structured `SetupRun` (outcome: `success` / `failed` /
`spawn-error` / `skipped`) persisted on `SprintExecution.setupRanAt`. Non-zero exit or spawn failure
hard-aborts the chain. The dirty-tree menu runs before setup, so every script that spawns is bracketed
by a `git status --porcelain` snapshot: only when the script adds entries that weren't there before
(a rewritten lockfile, generated files that aren't ignored) does the run re-offer keep / stash / reset /
cancel for that repo, naming the script. The non-interactive policies behave as they do at preflight:
`continue` logs the change and proceeds, `cancel` fails the run. Dirt the operator already kept is
never asked about again, a setup that leaves the tree alone adds no prompt, and a repo whose setup
changed the tree never seeds the `skipPreVerifyOnFreshSetup` baseline. A green run's `SetupRun` also
carries the check's durable answer (`SetupRun.tree` — outcome plus the paths the operator has now seen,
script-introduced ones listed before pre-existing dirt) once the check settles. Past 200 paths the list
is no longer cut: it collapses into `/`-terminated directory entries that each stand for everything
under them — deepest directories first, then whichever directory covers the most paths at each depth,
stopping as soon as it fits — and only a list that still doesn't fit even then is truncated
(`seenPathsTruncated`). Resume then skips a repo only when its LATEST run for that repo — ignoring
no-script `'skipped'` rows, which record that nothing touched the tree at that launch, same as a
resume-skip itself — is ITSELF a success of the current command and, whenever a tree check is wired
(which the implement flow always does), carries a complete (non-truncated) answer; a failed or
spawn-error run written after an earlier success, command drift, a row missing the answer, or a
truncated record all force a re-run on the next launch, each logged at info naming the reason. That
answer — this launch's own setup run, or carried forward from the persisted `SetupRun.tree` when setup
was resume-skipped — is what a parallel run's own per-worktree check reads (see below); it is never read
by re-inspecting the main checkout, which sibling folds keep changing mid-wave. Verify runs both
**pre-task** (before the AI) and **post-task** (after commit) with
an attribution algorithm (`clean` / `regressed` / `baseline-broken` / `fixed-baseline`) that avoids
blocking the AI for pre-existing failures. `Repository.verifyTimeout` caps both verify calls as `timeoutMs`
on the shell runner; absent → `DEFAULT_SHELL_TIMEOUT_MS` (5 min). Scripts are collected during
`detect-scripts` and persisted on `Repository.{setupScript,verifyScript,verifyTimeout}`. Persisted
`project.json` files written before v0.7.0 used `checkScript` / `checkTimeout`; the schema accepts those
legacy keys on read and rewrites the canonical names on the next save (no manual migration step).

**Per-worktree setup check (parallel).** Each parallel task's isolated worktree re-runs the repo's
`setupScript` from a fresh checkout (a worktree starts with none of the main repo's build state) and is
bracketed by the same before/after `git status` snapshot — but its verdict is matched against the main
checkout's recorded `SetupRun.tree` answer instead of asking the operator again: a path the main checkout
already saw (kept, stashed, or reset there, or introduced by that same script) is discarded from the
worktree right after setup, before the task's own `git add -A` commit runs, so it can neither ride into
that commit nor re-conflict the fold — logged at WARN, naming the discarded paths and the remedy (have
setup write generated output to git-ignored paths, or run tasks one at a time via
`concurrency.maxParallelTasks 1`), since a red verify in that worktree can trace back to the discard when
the build actually needed what was dropped; a path the main checkout never showed blocks that task alone
(`worktree-setup-failure`, `faultSide: 'environment'`) — kept with a warning instead, only under
dirty-tree policy `continue` — naming the script and the same fix. No recorded answer for the repo blocks
the task outright, since there is nothing to match against. The main checkout itself is never re-read for
this — sibling folds change it mid-wave — only the recorded answer on `ctx.setupTreeRecords`, whether it
came from this launch's own setup run or was carried forward from the persisted `SetupRun.tree` when
setup was resume-skipped.

**Structured verify gates.** `Repository.verifyGates` (`VerifyGate[]` — `{ pathPrefix, command, timeoutMs? }`)
wins over `verifyScript` when present and non-empty. Pre-task verify runs ALL gates (full attribution
baseline). Post-task verify runs only gates whose `pathPrefix` matches the attempt's diff footprint
(`git diff --name-only HEAD` + untracked), fail-fast — so a monorepo task touching one module does not pay
every other module's gate. A footprint probe failure or an empty footprint falls back to running all gates
(never a silent skip). The legacy single `verifyScript` normalises to one `pathPrefix: ''` catch-all gate.
`detect-scripts` emits a `VerifyGatesSignal` alongside the legacy `VerifyScriptSignal` for monorepo repos.
See `PERFORMANCE.md § Verify-gate cost and scoping` for the full picture.

**Red post-verify retry.** A post-task verify that comes back red with attribution `regressed`
(evaluator-passed attempt, harness-rejected) now grants a retry within the task's attempt budget
(`task.maxAttempts ?? harness.maxAttempts`) rather than blocking immediately. The failing verify command
and log tail are injected into the next attempt's generator prompt via the `RETRY_FEEDBACK_SECTION`
placeholder (the quarantine leaf stashes the rejected diff so the retry starts from the last clean commit).
Budget exhaustion still transitions to `blocked` and the commit guard independently keys on the block
reason, so red work never lands regardless of budget.

**Branch management.** `resolveBranchLeaf` prompts on first run; persists on `SprintExecution.branch`;
per-task preflight verifies the right branch. `ralphctl create-pr [--sprint <id>]` opens PR / MR via `gh` /
`glab` and persists `SprintExecution.pullRequestUrl`. `--sprint` defaults to the pinned current sprint (same as `sprint show` / `sprint progress`).
