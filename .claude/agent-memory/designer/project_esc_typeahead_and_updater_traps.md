---
name: project_esc_typeahead_and_updater_traps
description: Traps found in the retest pass — view-level esc plus global pop double-fires, state-updater refs lag, type-ahead design, test harness gaps
metadata:
  type: project
---

A view's hidden `esc` binding runs IN ADDITION to the global `router.pop()` (esc is not claimable; only `claimEscape` silences the global). A view that pops itself therefore pops twice and lands on Work. Let the global pop do the back-navigation; a view handles esc only when the global has nothing to do (stack root) or it claims escape.

**Why:** Execute's settled-run esc "matched the label" in `renderView` tests but jumped past Runs in the pty — `renderView` mounts no global keys. **How to apply:** test esc / back behaviour with `mountFrame` (`_app-frame.tsx`), not `renderView`.

Never advance a "latest value" ref inside a `setState` updater (the old `TextPrompt` did). React runs the updater eagerly only when the fiber has no pending work; once any other update is queued (a context change from `usePromptHints`), the updater defers to render and a fast `↵` after typing submits a stale buffer. Update the ref synchronously, then call `setState(value)`.

Type-ahead after a section switch: the new view mounts with its data loading, so `o` (binding gated on data) and `↓` (empty list) used to be dropped. `useViewKeys` now holds a gated-off key and `useListWindow` holds moves for 1.5 s after mount; `↵` is never held (it could open the wrong row). Keep new gated bindings on `enabled:`, not an early return inside `run`, so they get this for free.

`ScrollRegion`'s clip can cut a bordered box; the cue is drawn as that box's border row (`╰─ ▾ N more ──╯`). Any new bordered box inside a scroll body gets this automatically — don't add a per-view border workaround.
