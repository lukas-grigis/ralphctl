---
name: lesson-multi-render-transitions
description: Route pushes, effect-driven suppression and reload-after-mutate settle over several renders; one matching frame is not the settled state
metadata:
  type: feedback
---

Two flakes came from asserting on an intermediate frame:

- Route push then `useSuppressGlobalHints` (effect-driven) land in separate renders; a frame can already show the
  new route's footer while the Home-only `q/ctrl+c` hint is still present. Wait for the hint to disappear
  (`waitFor`), and include a positive rendered-footer check so an empty pre-render frame can't satisfy the absence.
- A view that calls `reload()` after a mutation shows: note + OLD list, then loading (list gone), then the rescanned
  list. A predicate on the note text plus a count that's also true for the old list matches the first window; the
  next keypress is lost. Wait on the post-rescan signature (e.g. `0 of <N-1>`), not just the note.
