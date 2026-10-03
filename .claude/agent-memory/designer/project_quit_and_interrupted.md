---
name: project-quit-and-interrupted
description: Quit-confirm and interrupted-task traps — Ink's own ctrl+c exit, hidden prompts still reading keys under an overlay, what "interrupted" does and does not know
metadata:
  type: project
---

- Ink's `exitOnCtrlC` defaults to true: Ink exits on `\x03` itself AND `useInput` never delivers ctrl+c, so a ctrl+c
  branch in `use-global-keys` is dead in production. ink-testing-library does not reproduce it (its tests passed while
  the real pty quit instantly with no confirm). The host now renders with `exitOnCtrlC: false`; anything mounted
  outside `Layout` (the migration gate) must handle ctrl+c itself.
- An overlay hides the view with `display: none`, but every `useInput` underneath stays live. A modal answered with
  `y` would also answer a ConfirmCard/prompt waiting under it, so prompt components read keys through
  `usePromptInput` (silent while the quit overlay is open). Gate on the overlay kind, not on `modalOpen`.
- `interrupted` = in_progress task + last attempt `running` + no live implement session in THIS process. It cannot see
  another ralphctl process running the same sprint, and a clean quit through the confirm also leaves the attempt
  `running` (so the row reappears on relaunch by design; the run record is gone, so Runs stays empty).
- Dirty-tree copy only says "likely from the interrupted attempt": under the parallel path the interrupted diff lives
  in the task's worktree, not the main checkout the preflight inspects.

**Why:** each was found only by driving the real binary or by reading Ink's source after a green suite.
**How to apply:** any new quit/confirm path needs a pty run; any new modal that answers single keys needs the prompt gate.
