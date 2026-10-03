---
name: keyboard-guard-lost-in-hook-migration
description: Migrating raw useInput handlers to useViewKeys silently drops the `if (ui.modalOpen) return` guard; useViewKeys mutes only for the overlay slot, not for queued prompts
metadata:
  type: feedback
---

`useViewKeys` computes `active = (options.active ?? true) && !overlayOpen`, where `overlayOpen` is the single overlay
slot (help / switcher / progress / evaluation). It does NOT know about `promptActive` (a queued prompt from a
background run renders inside every `ViewShell` via `PromptHost`). Views must pass `{ active: !ui.modalOpen }`
themselves. The old raw-`useInput` handlers carried `if (ui.modalOpen) return;` inline, so a mechanical migration that
forgets `active` turns a typed answer (or the `↵` that submits it) into a view action.

**Update:** `useViewKeys` now also reads `useOptionalOverlayState().modalOpen` itself, so a missing `active` option is no longer a leak for it. The remaining blind spot is any sibling `useInput` in the same view that is NOT `useViewKeys`: `ActionMenu` (needs `active={!ui.modalOpen}`), bare `useInput` for esc/↵ (welcome-view). Grep every `useInput(` and `<ActionMenu` for a modalOpen gate; help-open + esc then double-fires (closes help AND navigates).

**Why:** a review of a TUI keyboard-ownership refactor found `create-pr-view` (↵ = open an upstream PR) and
`doctor-view` converted with no `active` option; ten other `useViewKeys` callers had it. Neither the linter nor the new
key-ownership tests catch it — the tests mount one view with no queued prompt.

**How to apply:** after any hook migration, diff the per-file count of `modalOpen|promptActive` between `main` and
`HEAD` (`git show main:<f> | grep -c ...` vs `grep -c`) and chase every file where it dropped to 0. Then check
`useViewKeys(` call sites for a missing `{ active: ... }`. Destructive or outward-facing bindings (open PR, delete) are
the severity driver.
