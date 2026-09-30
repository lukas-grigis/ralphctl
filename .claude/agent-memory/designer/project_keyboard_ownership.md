---
name: project_keyboard_ownership
description: Claimed-keys registry + single overlay slot — traps when a view binds a key that a global handler also owns, and where overlays mount (Layout only)
metadata:
  type: project
---

`useViewKeys` claims its enabled printable bindings in `ClaimedKeysProvider`; `useGlobalKeys` and `StatusBanner` skip claimed keys. The catch: a view that USED to rely on both handlers composing (sprint-detail's `n` reseated the selection while the global `n` pushed Flows) breaks the moment it migrates — the claim silences the global one, so the view must do both itself.

**Why:** the claim is per key, not per action; there is no "also let the global run".

**How to apply:** when moving a view to `useViewKeys`, grep `use-global-keys.ts` `handleViewShortcut` for every letter the view binds and decide who navigates. Hint-strip budget is tight at 100 cols — adding a hint (sprints `m`) pushed `u unblock (N)` into the `… ? more` cell and broke four tests; order hints by value and keep labels one word.

Overlays (help/progress/evaluation) mount only in `App.tsx` Layout, so view tests rendered through `renderView` never see them; test help via `<HelpOverlay routeId=…/>` directly. `useViewKeys` and the claims hook tolerate a missing provider (no-op) so isolated tests need no extra wrapper.
