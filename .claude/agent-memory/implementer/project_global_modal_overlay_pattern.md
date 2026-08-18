---
name: project-global-modal-overlay-pattern
description: Two ways to render TUI modal overlays — per-view inline (HelpOverlay) vs App-Layout-level (ProgressOverlay). The latter wins when the modal is sprint-scoped or otherwise applies to many views.
metadata:
  type: project
---

Two coexisting modal patterns in the TUI:

1. **Per-view inline** — each view renders `{ui.helpOpen ? <HelpOverlay /> : <body>}`. Lives inside `ViewShell`'s scroll
   region. Used by `HelpOverlay`.
2. **App-Layout-level** — `App.tsx`'s `Layout` does `{ui.progressOpen ? <ProgressOverlay /> : children}` BEFORE the
   routed view mounts. Pattern used by `ProgressOverlay`.

**Why:** When the modal applies broadly (every sprint-scoped view) and you want it to behave like a true modal (cover
banner + view chrome, no list-cursor / scroll-region key races behind it), the Layout-level swap is dramatically less
invasive than editing every view. Touch ≈3 files instead of 15.

**How to apply:** Reach for the Layout-level pattern when the overlay is gated on global state (e.g.
`selection.sprintId !== undefined`) and you don't want to edit every view. Reach for the per-view pattern when the
overlay needs view-specific data only available inside the view's `Body`.

The Layout-level pattern also dodges the conflict between a letter-key hotkey (e.g. `g`) and any ScrollRegion / ListView
that uses the same letter.

**Update (2026-08-18):** the Layout no longer swaps children out — it wraps them in `display: overlayOpen ? 'none' :
'flex'` so they stay MOUNTED (list cursors / expanded cards survive the round trip), and every view-level `useInput`
gates on `ui.modalOpen` instead of unmounting. Consequence to remember: **a hidden subtree measures 0×0 via
`measureElement`.** Any component that reacts to its own measurement needs a zero-measurement guard, or opening an
overlay silently resets it — that was the ScrollRegion scroll-to-top bug (issue #292), fixed by ignoring a
zero-height viewport reading in its layout effect.

Related: [[feedback_src_next_chain_pattern]] (orthogonal — chain pattern, not UI),
[[project_tui_row_windowing_and_key_test_gotchas]].
