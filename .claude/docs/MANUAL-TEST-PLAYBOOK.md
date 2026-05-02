# Manual TUI Test Playbook

Automated tests pass on code-level invariants but can't see the alt-screen, the
keystroke timing, or the Claude handover. **Before claiming a TUI feature
"ready", walk through this playbook in a real terminal.** Each scenario is a
known regression or a new contract the agent is supposed to honour.

If you find a deviation, file it as a one-line bullet under "Known issues" at
the bottom and link the commit that fixes it.

## Setup

```bash
pnpm install
pnpm dev    # runs ralphctl from src against the real ~/.ralphctl/ data
```

If you want a clean slate:

```bash
RALPHCTL_ROOT=/tmp/ralphctl-test-$RANDOM pnpm dev
```

Use a real terminal (iTerm, Terminal.app, alacritty, kitty). Don't test inside
VS Code's integrated terminal — its alt-screen behaviour differs.

---

## Scenario 1 — onboarding a repo

**Setup:** at least one project registered with one repository.

1. Press `b` from Home → submenu opens
2. ↓ to "Projects" → Enter → Project submenu opens
3. ↓ to "Onboard repo" → Enter
4. **Expected:** routed to Execute view, project/repo selection prompt appears
   over a quiet canvas (no pipeline-map underneath)
5. Pick a repo → Enter
6. **Expected:** Claude takes over the full terminal (alt-screen exits,
   Claude Code UI appears). The ralphctl banner is GONE during the session.
7. Have a brief conversation with Claude, exit Claude
8. **Expected:** ralphctl re-appears with the alt-screen restored, the
   chain advances to the confirm-setup-script prompt
9. **Expected:** Setup-script prompt shows the AI's suggestion as the
   default value. Type `c` somewhere in the field — confirm it does NOT
   trigger Cancel Run on the execute view.
10. Submit each script confirm prompt
11. **Expected:** session ends with `[COMPLETED] onboard <repo>`. The
    breadcrumb shows `Home › Projects › Execute [1/1] onboard <repo>`.
12. Press Esc twice
13. **Expected:** lands back on Project submenu (not Home) — the submenu
    memory survives the round trip.
14. Click "Onboard repo" again on the same repo
15. **Expected:** the existing session is foregrounded (no duplicate launch).

---

## Scenario 2 — refining tickets (interactive)

**Setup:** a draft sprint with at least 2 tickets, all `pending`.

1. From Home pipeline-map, Enter on the "Refine" quick-action
2. **Expected:** routed to Execute view, "[1/N] refine <sprintId>" in
   breadcrumb. Per-ticket "Start refinement session for this ticket?"
   confirm appears (each ticket asks individually)
3. Press Enter to accept first ticket
4. **Expected:** Claude takes over with full Claude Code UI for ticket 1.
   The TUI is hidden during the session.
5. Have a conversation, ask Claude to write the requirements file when
   done, exit Claude
6. **Expected:** ralphctl re-appears with the parsed requirements shown
   inline, then "Approve these requirements?" prompt
7. Press Enter to approve
8. **Expected:** ticket 1 transitions to `approved`, sprint saved, chain
   moves to ticket 2
9. Repeat for ticket 2
10. **Expected:** session completes once all tickets done. Press Enter
    to pop back. Pipeline-map's Refine phase is now ✓ done.

**Negative tests:**

- Press 'c' while typing the setup script value → must NOT trigger Cancel
- Press 'b' while typing a description → must NOT open browse menu
- Press Tab inside a prompt → must go to the prompt's next field, not
  cycle sessions
- Press Esc inside a prompt → cancels the prompt, doesn't pop the view

---

## Scenario 3 — planning (interactive)

**Setup:** a draft sprint with all tickets `approved`.

1. From Home pipeline-map, Enter on the "Plan" quick-action
2. **Expected:** routed to Execute view, "plan <sprintId>" in breadcrumb
3. **Expected:** repo selection prompt appears (which repos to explore)
4. Pick repos → confirm
5. **Expected:** Claude takes over with full UI; the prompt instructs it
   to read the ticket requirements + write tasks to `<sprintDir>/planning/tasks.json`
6. Have a planning conversation, ask Claude to write the file, exit
7. **Expected:** ralphctl re-appears, parsed task list rendered in the
   TUI as a table
8. **Expected:** "Confirm ready to execute?" prompt
9. Press Enter
10. **Expected:** tasks saved, session completes. Pipeline-map now shows
    Execute as `◆ ready` with the next task count.

---

## Scenario 4 — execution (background-able)

**Setup:** an active sprint with tasks.

1. From Home, Enter on "Execute" quick-action OR press `s` on a sprint
   in the list
2. **Expected:** session starts, task grid populates progressively as
   parallel runners settle
3. Press `D` (uppercase D) to background the session
4. **Expected:** view pops back to wherever you came from, the
   `[1/1] execute <sprint>` indicator stays in the bottom-right
5. Press `x` to open Sessions list
6. **Expected:** the running session is listed
7. Press Enter on it
8. **Expected:** routed back to Execute view with the live trace
9. Press `c` to cancel
10. **Expected:** "Cancel running task and mark blocked?" confirm appears
11. Press 'n' or Esc to keep running
12. Press `c` again, this time confirm with 'y'
13. **Expected:** session aborts, status flips to `aborted`, the
    aborted-card shows. `c` and `D` keys are now no-ops; only Enter/Esc
    pop back.

**Negative tests:**

- Refine / plan / onboard sessions: pressing `D` must do NOTHING (those
  flows are foreground-only). Status hint should NOT show "background"
  for them.
- Tab between sessions multiple times → breadcrumb stack must stay
  flat at `Home › Execute`, never grow to `Home › Execute › Execute …`.

---

## Scenario 5 — keyboard discipline

Test that view-level shortcuts do NOT fire while a prompt owns the
keyboard. This is a regression class we keep fixing.

For every prompt context (an editor, a select, an input):

- Press the letters of common shortcut keys: `b`, `c`, `D`, `h`, `s`,
  `d`, `x`, `?`, `!`. Each should appear as text in the input or
  navigate the select — never trigger the matching shortcut.
- Press Enter to submit. The prompt resolves; THEN view-level shortcuts
  resume working.

---

## Scenario 6 — first-launch onboarding

**Setup:** clean data dir (`RALPHCTL_ROOT=/tmp/ralphctl-fresh pnpm dev`).

1. **Expected:** lands directly on `project-add` (above home in the stack)
2. Fill in project name + repo path
3. **Expected:** project saved, returns to home

---

## Scenario 7 — doctor

1. Press `!` from anywhere
2. **Expected:** doctor view runs all checks
3. **Expected:** the "Onboarding status" row, when failing, shows a
   short summary line followed by per-repo bullets indented below
   (NOT a single 200-char line of comma-separated repos)
4. Press Enter to pop back

---

## Known issues (file under here, link the fix commit)

- (none currently)

---

## What this playbook can't catch

The playbook covers TUI ergonomics and child-process handover —
exactly the surface that automated tests can't reach. Things still
NOT covered:

- Concurrency races at scale (e.g. 4 parallel tasks each emitting
  signals at 100Hz)
- Provider-specific Claude / Copilot quirks (rate-limit messages, etc.)
- File-system corner cases (NFS / SMB mounts, case-insensitive FS)

If you find a class of bug that recurs, add a scenario for it here
rather than fixing it once and waiting for the next regression.
