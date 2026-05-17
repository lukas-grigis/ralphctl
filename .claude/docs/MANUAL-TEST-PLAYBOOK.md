# Manual TUI Test Playbook

Automated tests pass on code-level invariants but can't see the alt-screen, the keystroke timing, or the AI
CLI handover. **Before claiming a TUI feature "ready", walk through this playbook in a real terminal.** Each
scenario is a known regression or a contract the agent is supposed to honour.

If you find a deviation, file it as a one-line bullet under "Known issues" at the bottom and link the commit
that fixes it.

## Setup

```bash
pnpm install
pnpm dev    # runs ralphctl from src against the real ~/.ralphctl-v2/ data
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

1. Press `b` (or whatever opens the browse submenu) from Home → Projects view
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
5. Have a conversation, ask the AI to write `requirements.md` when done, exit
6. **Expected:** ralphctl re-appears with the parsed requirements shown inline, then
   "Approve these requirements?" prompt
7. Press Enter to approve
8. **Expected:** ticket 1 transitions to `approved`, sprint saved, chain moves to ticket 2
9. Repeat for ticket 2
10. **Expected:** session completes once all tickets done. Press Enter to pop back. Pipeline-map's Refine phase
    is now ✓ done.

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
   write tasks to `<sprintDir>/planning/<unit>/plan.json`
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
2. **Expected:** session starts, task panel populates with the planned task list (depth-indented by
   `blockedBy`), the first task transitions to `IN PROGRESS`
3. Tab away to another running flow OR press the background hotkey
4. **Expected:** view pops back to wherever you came from, the `[N] implement <sprint>` indicator stays in
   the bottom-right or in the Sessions list
5. Open Sessions list
6. **Expected:** the running session is listed with status + age
7. Press Enter on it
8. **Expected:** routed back to Execute view with the live trace + the per-task panel + the recent-events tail
9. Watch a task settle:
   - **Expected:** generator runs, evaluator runs, post-task check runs, task transitions to `DONE`
10. Press the abort hotkey
11. **Expected:** "Cancel running task and mark blocked?" confirm appears
12. Press `n` or Esc to keep running
13. Press abort again, this time confirm with `y`
14. **Expected:** session aborts, status flips to `aborted`, the aborted-card shows. The current task resets
    to `todo` so the next launch can resume.

**Negative tests:**

- Refine / plan / readiness sessions: pressing the background hotkey must do NOTHING (those flows are
  foreground-only).
- Tab between sessions multiple times → breadcrumb stack must stay flat (`Home › Execute`), never grow
  (`Home › Execute › Execute …`).

---

## Scenario 5 — resume after kill

**Setup:** a sprint mid-implement with at least one task `in_progress`.

1. Force-quit ralphctl (Ctrl+C or kill the process)
2. Re-launch `pnpm dev`
3. Re-enter the **Implement** flow on the same sprint
4. **Expected:** any task left in `in_progress` from the prior run has been reset to `todo` and re-enters the
   queue (you don't see two attempts for the same task in the panel)
5. **Expected:** completed tasks stay `DONE`; planned ones stay `TODO`; no double-execution

---

## Scenario 6 — keyboard discipline

Test that view-level shortcuts do NOT fire while a prompt owns the keyboard. This is a regression class we
keep fixing.

For every prompt context (an editor, a select, an input):

- Press the letters of common shortcut keys: `b`, `c`, `D`, `h`, `s`, `d`, `?`, `!`. Each should appear as
  text in the input or navigate the select — never trigger the matching shortcut.
- Press Enter to submit. The prompt resolves; THEN view-level shortcuts resume working.

---

## Scenario 7 — first-launch onboarding

**Setup:** clean data dir (`RALPHCTL_HOME=/tmp/ralphctl-fresh pnpm dev`).

1. **Expected:** lands on the `WelcomeView` (above home in the stack) — first-run guidance
2. Drill into Projects → Create project
3. Fill in project name + repo path
4. **Expected:** project saved, returns to Home with the pipeline-map ready for sprint creation

---

## Scenario 8 — doctor

1. Press the doctor hotkey from anywhere
2. **Expected:** doctor view runs all checks: Node version, git, configured AI provider binary, data
   directory writability, project repos, current sprint health
3. **Expected:** failing rows include a short summary line and (where useful) per-item bullets indented below
4. Press Enter to pop back

---

## Scenario 9 — apply-feedback (review)

**Setup:** a sprint in `review` status (every task `done`).

1. From Home, select the **Review** flow
2. **Expected:** routed to Execute view, the multi-line editor prompt appears asking for feedback
3. Type a short feedback message; Ctrl+D to submit
4. **Expected:** AI CLI takes over; resumes the relevant tasks via session-id resume to apply the feedback
5. AI exits; check scripts re-run; evaluator re-runs
6. **Expected:** progress.md gets the new round's entries; chain.log captures the trace
7. From the same flow, submit an EMPTY input (just Ctrl+D)
8. **Expected:** the loop exits cleanly, sprint stays in `review`

To close the sprint: `ralphctl sprint close <sprint-id>` from a separate terminal, or pick the Close flow
from the TUI.

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
- Concurrency under load — the implement flow runs strictly sequential, but cross-process locks (the
  `<stateRoot>/locks/sprints/<id>.lock` file) are best tested with two real ralphctl processes.

If you find a class of bug that recurs, add a scenario for it here rather than fixing it once and waiting
for the next regression.
