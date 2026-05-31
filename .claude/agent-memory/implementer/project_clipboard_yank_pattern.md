---
name: clipboard-yank-pattern
description: TUI clipboard copy + global `y` hotkey uses an `ActiveTaskSummaryProvider` closure registered on UiState via ref (not state) so the global handler can read the live active-task snapshot without re-rendering every consumer
metadata:
  type: project
---

The `y` (yank) hotkey copies a markdown summary of the operator's currently-focused task to the clipboard. The plumbing:

- `src/integration/io/clipboard.ts` — platform-detecting writer (`pbcopy` / `wl-copy` / `xclip -selection clipboard` /
  `clip.exe`). Returns `Result<void, ClipboardError>`; never throws. Injectable `Spawn` for tests.
- `src/application/ui/tui/runtime/render-active-task-summary.ts` — pure renderer over `TaskBucket` + display name →
  markdown.
- `UiStateApi.setActiveTaskSummaryProvider(provider | undefined)` + `getActiveTaskSummary()` — provider is stored in a
  `useRef`, not `useState`, so the execute view can swap the closure on every bucketed-data change without re-rendering
  every UiState consumer (which would thrash unrelated views).
- The execute view registers the provider in a `useEffect([currentTask, currentTaskName, ui])` and unregisters on
  cleanup.
- The global `y` handler in `use-global-keys.ts` calls the provider, copies, and emits a 2s `clipboard-copy` banner via
  the existing event-bus banner pipeline (`banner-show` then a `setTimeout` `banner-clear`).

**Why:** the `y` hotkey is global (operator can press from any view) but the data is execute-view-local. UiState as a
registration seam keeps the data ownership clean while letting the handler stay global.

**How to apply:** if you need another global hotkey that operates on view-local data (e.g. "j to copy current commit
hash"), follow the same ref-based provider registration on `UiState`. Avoid storing per-view computed data in context
state — every UiState consumer would re-render on each frame.
