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
10. **Expected:** session ends with `[COMPLETED] readiness <repo>`. The breadcrumb shows the path.
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
6. **Expected:** ralphctl re-appears with the parsed requirements shown inline, then
   "Approve these requirements?" prompt
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
8. **Expected:** "Confirm ready to execute?" prompt
9. Press Enter
10. **Expected:** tasks saved, session completes. Pipeline-map now shows Implement as `◆ ready` with the next
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

---

## Scenario 9 — doctor

1. Press the doctor hotkey from anywhere
2. **Expected:** doctor view runs all checks: Node version, git, configured AI provider binary, data
   directory writability, project repos, current sprint health
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

## Known issues (file under here, link the fix commit)

- (none currently)

---

## What this playbook can't catch

The playbook covers TUI ergonomics and child-process handover — exactly the surface that automated tests
can't reach. Things still NOT covered:

- Real provider integration: every Claude / Copilot / Codex provider test uses a fake `spawn`. JSON-shape
  drift will surface here first.
- File-system corner cases (NFS / SMB mounts, case-insensitive FS).
- Concurrency under load — the implement flow runs strictly sequential (or parallel when
  `maxParallelTasks > 1`), but cross-process lock contention (the `<stateRoot>/locks/repo-<hash>.lock/`
  directory) and the heartbeat crash-reclaim path are best tested with two real ralphctl processes
  (see Scenario 14).

If you find a class of bug that recurs, add a scenario for it here rather than fixing it once and waiting
for the next regression.
