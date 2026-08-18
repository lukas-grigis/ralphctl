# Manual TUI Test Playbook

Automated tests pass on code-level invariants but can't see the alt-screen, the keystroke timing, or the AI
CLI handover. **Before claiming a TUI feature "ready", walk through this playbook in a real terminal.** Each
scenario is a known regression or a contract the agent is supposed to honour.

If you find a deviation, file it as a one-line bullet under "Known issues" at the bottom and link the commit
that fixes it.

## Setup

```bash
pnpm install
pnpm dev    # runs ralphctl from src against the real ~/.ralphctl/ data
```

If you want a clean slate:

```bash
RALPHCTL_HOME=/tmp/ralphctl-test-$RANDOM pnpm dev
```

Use a real terminal (iTerm, Terminal.app, alacritty, kitty). Don't test inside VS Code's integrated terminal —
its alt-screen behaviour differs.

---

## Scenario 1 — readiness check on a repo

**Setup:** at least one project registered with one repository.

1. From the Home action menu, press `p` to open the Projects view
2. Drill into a project → repository detail
3. Pick the "Run readiness" flow
4. **Expected:** routed to Execute view, project/repo selection prompt appears over a quiet canvas
5. Confirm → AI CLI takes over the full terminal (alt-screen exits, the AI's own UI appears). The ralphctl
   banner is GONE during the session.
6. Have a brief conversation with the AI, exit
7. **Expected:** ralphctl re-appears with the alt-screen restored, the chain advances to the
   `agents-md` confirmation prompt
8. **Expected:** prompt shows the AI's suggestion as the default. Type `c` somewhere in the field — confirm
   it does NOT trigger a global hotkey on the underlying execute view.
9. Submit each confirm prompt
10. **Expected:** session ends with a result card showing `✓ Readiness — <project-name> — completed`. The breadcrumb shows the path.
11. Press Esc back to Home

---

## Scenario 2 — refining tickets (interactive)

**Setup:** a draft sprint with at least 2 tickets, all `pending`.

1. From Home pipeline-map (or the flows view), select the **Refine** flow
2. **Expected:** routed to Execute view, `refine <sprint-id>` in breadcrumb. Per-ticket "Start refinement
   session for this ticket?" confirm appears (each ticket asks individually)
3. Press Enter to accept first ticket
4. **Expected:** AI CLI takes over with full UI for ticket 1. The TUI is hidden during the session.
5. Have a conversation; the AI emits its approved requirements as a `refined-ticket` signal into `signals.json` when
   done, then exit
6. **Expected:** ralphctl re-appears with the parsed requirements shown inline, then an approval
   prompt titled `Approve refined requirements for "<ticket title>"?` that shows the proposed body
   inline, offering choices Approve / Edit / Reject (plus "Post as comment" when the ticket has a
   linked issue). Pressing Enter selects the highlighted default (Approve, unless "Post as comment"
   leads via `settings.scm.postRefinementComment` + a link)
7. Press Enter to approve
8. **Expected:** ticket 1 transitions to `approved`, sprint saved, chain moves to ticket 2
9. Repeat for ticket 2
10. **Expected:** session completes once all tickets done. Press Enter — lands on Home with the same
    project/sprint still selected. Pipeline-map's Refine phase is now ✓ done.

**Negative tests:**

- Press `s` while typing the requirements text → must NOT open Settings overlay
- Press `b` while typing a description → must NOT open browse menu
- Press Tab inside a prompt → must go to the prompt's next field, not cycle flow sessions
- Press Esc inside a prompt → cancels the prompt, doesn't pop the view

---

## Scenario 3 — planning (interactive)

**Setup:** a draft sprint with all tickets `approved`.

1. From Home pipeline-map, select the **Plan** flow
2. **Expected:** routed to Execute view, `plan <sprint-id>` in breadcrumb
3. **Expected:** repo selection prompt appears (which repos to explore)
4. Pick repos → confirm
5. **Expected:** AI CLI takes over with full UI; the prompt instructs it to read the ticket requirements +
   write the dependency-ordered task array as a `task-plan` signal to `signals.json` in its output directory
   under `<sprintDir>/plan/<run-slug>/`
6. Have a planning conversation, ask the AI to write the file, exit
7. **Expected:** ralphctl re-appears, parsed task list rendered as a table
8. **Expected:** if the plan has an obvious quality gap (a task with no verification criteria, a
   placeholder command, a duplicate criterion id, …), a "Plan check found N issue(s) — advisory, you
   decide:" block renders above the task list, error findings before warnings
9. **Expected:** "Confirm ready to execute?" prompt regardless of findings — the critic never blocks
10. Press Enter
11. **Expected:** tasks saved, session completes. Pipeline-map now shows Implement as `◆ ready` with the next
    task count.

---

## Scenario 4 — implement (background-able, sequential)

**Setup:** an active sprint with planned tasks.

1. From Home, select the **Implement** flow
2. **Expected:** session starts, task panel populates with the planned task list (cards collapsed by
   default), the first task transitions to `IN PROGRESS`. Press `j`/`k` to move between cards; press
   `Enter` or `Space` to expand the focused card. Press `e` to expand done-criteria.
3. **Expected:** setup-script runs once per repo — baseline-health chip shows `success` / `failed` /
   `skipped` per repo in the context column (≥180 col terminal). `BaselineHealthCard` lists full history.
4. **Expected:** `round N/M` in the task header updates via `TaskRoundStarted` events (not a ref hack).
   ETA estimate (median of past settled attempts) appears once the first attempt settles.
5. Press `g` to open the progress overlay
6. **Expected:** `progress.md` renders as a full-screen overlay. Press `g` again or `Esc` to close.
7. Press `y` (yank)
8. **Expected:** a brief "Copied to clipboard" `info` banner flashes. Paste confirms the task summary text.
9. Press `b` to toggle banner compact ↔ full. Banner collapses to a single line; pressing `b` restores.
10. Tab away to another running flow OR press the background hotkey (`D`)
11. **Expected:** view pops back to wherever you came from, the `[N] implement <sprint>` indicator stays in
    the Sessions list
12. Open Sessions list, press Enter on the session
13. **Expected:** routed back to Execute view with the live trace + the per-task panel + recent-events tail
14. Watch a task settle:
    - **Expected:** pre-task-verify runs, generator runs, evaluator runs, post-task-verify runs (attribution
      chip: `clean`), task transitions to `DONE`. `TokenBudgetCard` updates in the context column.
15. Press `c` (cancel-scope picker)
16. **Expected:** overlay appears offering "cancel attempt" vs "cancel whole flow". Press `Esc` to dismiss.
17. Confirm cancellation via the overlay — two distinct outcomes depending on which option you chose:
18. **"Stop run now" (cancel-attempt):** the chain is aborted immediately; no repo write for the task — the
    task stays `in_progress` (no repo write occurs). On the next Implement launch it is queued first and
    `start-attempt` settles the aborted attempt in history, then opens a fresh attempt. The attempt header
    reads "attempt N · resumed from aborted M at HH:MM".
    **"Stop and mark blocked" (cancel-flow):** `cancelActiveTaskUseCase` calls `markTaskBlocked(task, 'user
cancel', 'own')` — the task lands `blocked` and is not re-entered automatically. Re-entry requires
    `ralphctl task unblock` (or TUI `u`). The session also aborts after the write.

**Negative tests:**

- Refine / plan / readiness sessions: pressing `D` must do NOTHING (those flows are foreground-only).
- Tab between sessions multiple times → breadcrumb stack must stay flat (`Home › Execute`), never grow.
- Press `g` outside an active sprint → must show an appropriate empty / error state, not crash.

---

## Scenario 5 — forensic CLI commands (export-context + runs)

**Setup:** a sprint that has had at least one implement run (so `progress.md` exists). To exercise the
optional `events.ndjson` step below, run that implement spawn with `RALPHCTL_DEBUG_TRACE=1`.

1. Run `ralphctl export-context --sprint <id> --project <id> --output /tmp/context.md`
2. **Expected:** a markdown digest of the sprint state (sprint + project + tasks) is written to the output
   path; stdout prints a one-line `wrote <path> (<bytes>)` confirmation. Exit 0. No Ink mount. Open the file
   to confirm the task list and sprint metadata are present.
3. (Optional, when `RALPHCTL_DEBUG_TRACE=1` was set during the run) Verify `events.ndjson` contains
   `=== chain-run <id> <flowId> started <iso> ===` / `… completed …` brackets around each run.
4. Run `ralphctl runs list`
5. **Expected:** table of per-run forensic artifacts (run id, flow, started, outcome, step counts). Exit 0.
6. Run `ralphctl runs prune --keep-last 3` (adjust N to taste)
7. **Expected:** older run artifacts removed; the three most recent are retained. Confirm with another
   `ralphctl runs list`.

---

## Scenario 6 — resume after kill

**Setup:** a sprint mid-implement with at least one task `in_progress`.

1. Force-quit ralphctl (Ctrl+C or kill the process)
2. Re-launch `pnpm dev`
3. Re-enter the **Implement** flow on the same sprint
4. **Expected:** any task left in `in_progress` from the prior run stays `in_progress` and is queued FIRST.
   On its first `start-attempt` the prior `running` attempt is settled as `aborted` (cause `process-crash`,
   visible in the per-task attempts panel) — you WILL see the aborted attempt in history. A fresh attempt
   opens and the task resumes in place; it does not reset to `todo`.
5. **Expected:** completed tasks stay `DONE`; planned ones stay `TODO`; no double-execution

---

## Scenario 7 — keyboard discipline

Test that view-level shortcuts do NOT fire while a prompt owns the keyboard. This is a regression class we
keep fixing.

For every prompt context (an editor, a select, an input):

- Press the letters of common shortcut keys: `b`, `c`, `D`, `g`, `h`, `j`, `k`, `s`, `d`, `y`, `?`, `!`.
  Each should appear as text in the input or navigate the select — never trigger the matching shortcut.
- Press Enter to submit. The prompt resolves; THEN view-level shortcuts resume working.

---

## Scenario 8 — first-launch onboarding

**Setup:** clean data dir (`RALPHCTL_HOME=/tmp/ralphctl-fresh pnpm dev`).

1. **Expected:** lands on the `WelcomeView` (above home in the stack) — first-run guidance
2. Drill into Projects → Create project
3. Fill in project name + repo path
4. **Expected:** project saved, returns to Home with the pipeline-map ready for sprint creation

**8a — zero-CLI keypress gate.** Repeat with no AI CLI on `PATH` (e.g. a scrubbed `PATH` env var).

1. **Expected:** lands on `WelcomeView` showing "No AI CLIs detected — install one …" plus "Press ↵ to
   continue" — the view holds here instead of auto-routing away
2. Press `↵` (or space) — **expected:** routes to create-project (or Home if a project already exists)
3. Repeat, press `Esc` instead — **expected:** same route; the global back-navigation handler does NOT
   also fire on the same keystroke

---

## Scenario 9 — doctor

1. Press the doctor hotkey from anywhere
2. **Expected:** doctor view runs all checks: Node version, git, configured AI provider binary + auth
   (per-provider — Claude/Codex show pass/warn, OpenCode shows credential count, Copilot always shows
   `unknown` since its CLI has no auth-status verb), data directory writability, project repos, current
   sprint health
3. **Expected:** failing rows include a short summary line and (where useful) per-item bullets indented below
4. Press Enter to pop back

---

## Scenario 10 — apply-feedback (review)

**Setup:** a sprint in `review` status (every task `done`).

1. From Home, select the **Review** flow
2. **Expected:** routed to Execute view, the multi-line editor prompt appears asking for feedback
3. Type a short feedback message; Ctrl+D to submit
4. **Expected:** AI CLI takes over; resumes the relevant tasks via session-id resume to apply the feedback
5. AI exits; verify scripts re-run; evaluator re-runs
6. **Expected:** progress.md gets the new round's entries; if `RALPHCTL_DEBUG_TRACE=1` is set, events.ndjson captures
   the trace
7. From the same flow, submit an EMPTY input (just Ctrl+D)
8. **Expected:** the loop exits cleanly, sprint stays in `review`

To close the sprint: `ralphctl sprint close <sprint-id>` from a separate terminal, or pick the Close flow
from the TUI.

---

## Scenario 11 — step-label rendering in Execute view

**Setup:** a sprint with at least one multi-repo preflight step (so the implement flow generates preflight
leaves whose `name` contains an absolute repo path).

1. Start the **Implement** flow on the sprint
2. Watch the flow-steps rail as preflight tasks fire
3. **Expected:** the rail shows short labels (e.g. `preflight · my-repo`) — NOT the raw element name
   that embeds the absolute path (`preflight-task-1-/Users/...`). Path-jammed names must not appear in the
   rendered rail.
4. Resize the terminal narrower (below `xl`, i.e. < 180 cols) so the three-column layout collapses
5. **Expected:** rail width shrinks to the fixed 28-col `RAIL_WIDTH` (or the 6-col icons-only compact rail at
   the `md` 100–139 breakpoint); labels that exceed the budget are mid-truncated with
   `…` rather than wrapping mid-word or overflowing into the adjacent column.
6. Resize back to ≥ 180 cols
7. **Expected:** rail grows fluidly (from 36 up to ~56 cols at wide widths) and the labels breathe without any
   layout jitter.

---

## Scenario 12 — cross-project sprint picker

**Setup:** at least two projects registered, each with at least one sprint.

1. From any view, press `S`
2. **Expected:** a cross-project sprint picker opens showing sprints from the current project (if one is
   set) or all sprints when no project is selected. Picker is a modal overlay — global shortcuts must NOT
   fire through it.
3. Press `t` inside the picker
4. **Expected:** scope toggles — if the picker was showing current-project sprints, it now shows all
   sprints across every project; pressing `t` again returns to project scope.
5. Press `f` inside the picker
6. **Expected:** done sprints are hidden (the counter and visible rows reflect only non-done sprints);
   pressing `f` again restores them. When `f` hides everything, a "All sprints here are done (hidden)"
   message with a "Press f to show them" hint renders in place of the list.
7. Navigate the list with `↑`/`↓`, select a sprint from a different project with `Enter`
8. **Expected:** both the active project and active sprint update atomically — the breadcrumb reflects the
   new project/sprint combination (including a `[S]` affordance next to the sprint name), and no partial
   state is visible mid-transition.
9. Press `S` again from Home with NO project loaded
10. **Expected:** picker opens in all-projects scope; `t` and `f` still toggle without crashing.

**Negative tests:**

- Press `b`, `g`, `h`, `?`, etc. while the picker is open → must be absorbed by the picker, not the
  underlying view.
- Press `Esc` → picker closes; the previously selected project/sprint is unchanged.

---

## Scenario 13 — Home digit shortcuts and Projects browse-only behaviour

**Setup:** at least two sprints exist under the current project (so the "switch sprint" section of the
Home action menu shows multiple recent-sprint rows).

1. From Home, note the recent-sprint rows in the "switch sprint" section — up to five are listed
2. Press `1`, then `2` (digit keys)
3. **Expected:** pressing `1` selects the first recent sprint; a `✓ now on <name>` toast flashes above
   the menu. Pressing `2` switches to the second. The breadcrumb `[S]` label updates to reflect each switch.
4. Navigate to Projects (`p` from Home)
5. Move the cursor over a project that is NOT the current one
6. Press `Enter` to open its detail view
7. **Expected:** the breadcrumb right-side still shows the original project and sprint — opening a
   project detail is a browse and must NOT switch the current project or clear the sprint cursor.
8. Press `m` while in the project detail view
9. **Expected:** the project switches to the viewed one; feedback line `✓ now on <project-name>` appears;
   the breadcrumb right-side updates.
10. Press `Esc` back to the Projects list; press `m` on a different focused row without drilling in
11. **Expected:** the project switches directly from the list view; same feedback and breadcrumb update.

**Negative test:** press `Enter` on any project in the list (without `m`) and navigate away — the
original project selection must be unchanged on the breadcrumb.

---

## Scenario 14 — cross-process advisory lock

**Setup:** a sprint with at least one task remaining (`todo`). Two separate terminal tabs.

1. In terminal A, start the **Implement** flow on the sprint — let it reach the first AI session (so the
   lock is held and the heartbeat is running)
2. Within ~5 seconds (before any crash-reclaim threshold), start the **same** Implement flow on the
   **same sprint** in terminal B
3. **Expected:** terminal B immediately shows a warn banner — "Repository lock held by another process —
   could not acquire after retries" — and the chain halts. Terminal A continues running normally.
4. Kill terminal A's process (`Ctrl+C`)
5. Wait ~30 seconds for the default crash-reclaim window (`DEFAULT_STALE_AFTER_MS`) to elapse — the
   heartbeat stops, the lock directory goes stale
6. Re-start the Implement flow in terminal B
7. **Expected:** terminal B acquires the lock and resumes normally — the previously `in_progress` task stays
   `in_progress` and is queued FIRST; `start-attempt` settles the crashed `running` attempt as `aborted`
   (kept in history) and opens a fresh attempt automatically

**Negative tests:**

- Do NOT manually delete the `<stateRoot>/locks/repo-<hash>.lock/` directory while a holder is alive —
  the compromised-lock path should trigger an `AbortError` tear-down, not a silent hang.
- Verify no double-execution: tasks completed in terminal A before the kill must remain `done` after
  terminal B resumes.

---

## Scenario 15 — OpenCode backend, zero-auth free tier

**Setup:** `opencode` CLI installed (`npm i -g opencode-ai`), no credentials configured. Stamp the whole `ai`
section onto OpenCode's free tier first:

```bash
ralphctl settings apply-preset opencode-only
```

**15a — interactive flow (refine):**

1. Register a project with at least one draft-sprint ticket in `pending`
2. From Home pipeline-map, select the **Refine** flow
3. Accept the per-ticket confirm prompt
4. **Expected:** `opencode` takes over the full terminal (alt-screen exits, OpenCode's own UI appears);
   converse briefly, then exit
5. **Pass condition:** ralphctl re-appears with the parsed refined requirements shown inline — this only
   happens if OpenCode actually wrote a `refined-ticket` signal into `signals.json` under
   `<sprintDir>/refinement/<ticket-slug>/`. Confirm the file exists and is non-empty
6. Approve the requirements; ticket transitions to `approved`

**15b — headless flow (readiness):**

1. From the same project, run the **Run readiness** flow (Projects → repository detail → "Run readiness")
2. Confirm the project/repo selection prompt
3. **Expected:** the flow runs headless (no OpenCode UI takeover) and returns to the `agents-md` confirmation
   prompt with the AI's suggested content shown as the default
4. **Pass condition:** a `signals.json` file exists under the run's output directory
   (`ralphctl runs list --flow readiness` to find it) and the readiness result card shows
   `✓ Readiness — <project-name> — completed`
5. Submit the confirm prompt; verify `AGENTS.md` is written at the repo root

**Negative test:** if `opencode` has no free-tier reachability (offline, upstream outage), both runs should
fail with a clear provider error — not a silent hang or an empty `signals.json`.

---

## Scenario 16 — `ralphctl demo`

**16a — plain mode:**

1. `ralphctl demo --no-launch` from a clean shell
2. **Expected:** stdout prints the seeded sandbox summary (home dir, repo, project, the seeded
   `ai : <provider>-only preset` line, three sprints — one per pre-flow state) and the
   `RALPHCTL_HOME=… ralphctl` launch command; no TUI opens. The named preset must match the AI CLI
   actually on your PATH — launching Implement on the "ready to implement" sprint must not fail
   preflight asking for a _second_ provider's CLI. With no AI CLI installed at all the line reads
   `claude-only preset (no AI CLI on PATH — placeholder …)`
3. `ralphctl demo` (no `--no-launch`) — **expected:** TUI opens directly into the sandbox's Home view,
   no `WelcomeView` (settings are pre-seeded)
4. Re-run `ralphctl demo --no-launch` — **expected:** the sandbox is wiped and reseeded from scratch
   (the `.ralphctl-demo` marker lets the command trust it owns the directory)
5. `ralphctl demo --home /tmp/some-existing-non-demo-dir --no-launch` where that dir exists and was NOT
   created by this command — **expected:** refuses with a clear error, does NOT touch the directory

**16b — scripted mode (no provider CLI or auth needed):**

1. `ralphctl demo --script` on a machine with NO AI CLI installed
2. **Expected:** the TUI launches into the sandbox; starting Implement on the seeded sprint replays a
   canned two-round generator → evaluator transcript (FAIL → retry → PASS) through the real `claude-code`
   adapter's plumbing — no `claude` binary is spawned, and the sprint settles `done`
3. **Expected:** stdout printed before launch names scripted mode explicitly (every AI row pinned to
   claude-code, verify script rewritten to a portable one-liner)

---

## Scenario 17 — plateau calibration honours `plateauThreshold`

**Setup:** a sprint with one task carrying a verification criterion the generator cannot satisfy (e.g. "the
verify script exits 0" against a script that always exits 1), so the gen-eval loop genuinely stalls.

```bash
ralphctl settings set harness.plateauThreshold 3
ralphctl settings show | grep entropyPlateauDetector   # expect false — the entropy detector is opt-in
```

1. Run Implement on that sprint and watch the Execute view's step rail
2. **Expected:** neither `loop-diversity-check` nor `entropy-check` exits the loop before turn 3 — both
   window from `plateauThreshold`, so an earlier exit is the regression this scenario exists to catch
3. **Expected:** when the plateau does fire, the banner names the escalation (model rung, or the effort rung
   for both generator **and** evaluator) — not a bare "plateau"
4. `ralphctl settings set harness.entropyPlateauDetector true`, re-run — **expected:** the entropy detector
   now participates, and still cannot end an attempt on a single turn
5. **Pass condition:** `ralphctl runs stats --sprint <id>` reports the plateau under the source that actually
   fired (`threshold` / `diversity` / `entropy`), and the escalation rung shows as resolved or fell-through

---

## Scenario 18 — outcome rollup: `runs stats`, the sprint card, and next steps

**18a — CLI rollup:**

1. `ralphctl runs stats` on a data root with at least one sprint holding a mix of done / blocked tasks
2. **Expected:** outcome mix, first-pass rate, attempts-to-done, plateau-by-source, escalation efficacy, the
   regression taxonomy (`clean` / `fixed-baseline` / `baseline-broken` / unattributed), warnings broken out by
   kind, and per-criterion pass rates — each rate labelled with the denominator it quotes
3. `ralphctl runs stats --json` — **expected:** the same numbers as raw JSON, stable key order (diff two runs)
4. `ralphctl runs stats --sprint <id> --project <id>` — **expected:** refused, the two are mutually exclusive
5. `RALPHCTL_HOME=/tmp/ralphctl-empty-$RANDOM ralphctl runs stats` — **expected:** the one-line
   "no sprints yet" notice, exit 0, no stack trace; the same command with `--json` still emits a well-formed
   all-zero report

**18b — sprint outcome card:**

1. Open a `review` sprint's detail view — **expected:** the outcome card renders between the next-phase card
   and the tickets section, with the same numbers `runs stats --sprint <id>` prints
2. Open a `draft` or `active` sprint — **expected:** no card at all (nothing to report before an attempt ran)
3. On a sprint where an attempt was attributed `baseline-broken` or `regressed` — **expected:** the card takes
   the error tone

**18c — next steps / post-mortem:**

1. Let a flow run to completion — **expected:** the settled result card ends with a `Next steps` block naming
   the recommended flow and the key that launches it; the settled hint row reads
   `↵ home · r re-run · g progress` (plus `v evaluation` when the focused task has a verdict)
2. Press `r` — **expected:** it returns to Flows, which re-checks triggers against the sprint's status **now**
   (a sprint that advanced during the run offers the next flow, not a stale repeat)
3. Cancel a run with `Ctrl+C` — **expected:** a `Post-mortem` block lists only artifacts that actually exist on
   disk (`progress.md`, trace, verify logs, sprint dir); a `create-sprint` that failed before creating a sprint
   shows no paths rather than a guessed one
4. **Pass condition:** Home and Flows recommend the same next action for the same sprint, in every state —
   including `review` (two flows offered) and `done` (points at the pull request)

---

## Scenario 19 — evaluation verdict surface

**Setup:** a sprint with at least one task whose latest attempt has an evaluator verdict (a failed round is the
interesting case), plus one task that has never been evaluated.

**19a — TUI overlay:**

1. In the Execute view's tasks panel, focus the evaluated task and press `v`
2. **Expected:** a read-only overlay opens on that attempt's `evaluation.md` — critique plus each dimension's
   pass / fail / n-a with its finding and any command output; the same scroll chords as the `g` progress
   overlay; `Esc` or `v` closes it
3. Focus the never-evaluated task — **expected:** the `v` hint is disabled, and pressing `v` does nothing
4. Repeat from a sprint-detail task row — **expected:** identical overlay, identical keys
5. On a task whose record predates the artifact, or whose workspace was pruned — **expected:** it degrades to
   the one-line verdict, never an error

**19b — CLI reader:**

1. `ralphctl task evaluation <taskId> --sprint <id>`
2. **Expected:** the attempt / verdict / path header goes to **stderr**, the artifact body to stdout — so
   `ralphctl task evaluation <taskId> > verdict.md` yields exactly the file
3. **Pass condition:** the body matches what the overlay rendered for the same task

---

## Known issues (file under here, link the fix commit)

- (none currently)

---

## What this playbook can't catch

The playbook covers TUI ergonomics and child-process handover — exactly the surface that automated tests
can't reach. Things still NOT covered:

- Real provider integration: every Claude / Copilot / Codex / OpenCode provider test uses a fake `spawn`.
  JSON-shape drift will surface here first — Scenario 15 is the one place OpenCode runs against the real CLI.
- File-system corner cases (NFS / SMB mounts, case-insensitive FS).
- Concurrency under load — the implement flow runs strictly sequential (or parallel when
  `maxParallelTasks > 1`), but cross-process lock contention (the `<stateRoot>/locks/repo-<hash>.lock/`
  directory) and the heartbeat crash-reclaim path are best tested with two real ralphctl processes
  (see Scenario 14).

If you find a class of bug that recurs, add a scenario for it here rather than fixing it once and waiting
for the next regression.
