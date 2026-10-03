---
name: project_revamp_rollback
description: The five-section/tab-bar TUI revamp was rejected; the original Home/menu TUI is the base with a small keep-list — what that means for new UI work
metadata:
  type: project
---

The maintainer tried the section/tab-bar/location-line/Work-agenda/switcher-overlay/compact-banner TUI and rejected it ("felt less natural, used space worse"). The base is the original TUI: 12-row boxed banner, breadcrumb header line, Home with grouped menu (`[hotkey]` per row), full-screen Switch sprint/project views, digit quick-switch. Kept on top: interrupted-task and WAITING surfaces (Home `NEEDS ATTENTION`, Sessions, Execute header, footer), quit confirm, removal through `sprintRemoval`/`projectRemoval`, Housekeeping, actionable Doctor, keystroke-ownership fixes.

**Why:** the revamp tag `backup/tui-revamp` is reference only.

**How to apply:** do not reintroduce tabs, sections or a location line; new states join Home's menu groups or the sprint card. Lean on `ui/shared/next-steps.ts` (flow rows render `◆ Label — detail`) and keep `flows-visibility.ts` agreeing with it.
