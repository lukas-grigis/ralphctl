---
name: project_keyboard_ownership
description: Keystroke-ownership rules on the original (non-sections) TUI — overlays outrank hidden prompts, view keys mute under overlays, ctrl chords never hit bare-letter bindings, one clipped line for header/footer
metadata:
  type: project
---

Overlays (help/progress/evaluation/quit) hide the view with `display: none` but every `useInput` underneath stays live, so ownership is enforced in the hooks: prompt components read keys via `usePromptInput` (inactive while `ui.overlayOpen`), `useViewKeys` is inactive while any overlay is open, and `useGlobalKeys` keeps handling overlays even when a prompt mutes the ambient keys.

**Why:** a confirm queued behind help answered on `↵`/`y`; a view's `c` fired on the same `ctrl+c` that opened the quit confirm (both handlers get one event before React re-renders).

**How to apply:** new input surfaces use `usePromptInput` / `useViewKeys`, never raw `useInput`, unless they are the overlay itself. Letters `g` (progress overlay) and `h` (Home) are global — never a scroll or confirm key. `useViewKeys` tokens `↵` and `space` match by name.

Header/footer chrome: build each line from ONE truncating `Text`, never sibling Boxes (a shrinking Box row wraps text into one-letter columns). The footer drops whole hints (`fitHints`) before clipping; project-detail's local hints exceed 100 cols on their own, so tests asserting them render with `size: { columns: 140 }`.

Overlays mount only in `App.tsx` Layout, so `renderView` tests never see them; mount `Layout` (see `quit-confirm.test.tsx`) to test overlay ownership.
