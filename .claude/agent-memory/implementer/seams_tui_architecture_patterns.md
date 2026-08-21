---
name: seams_tui_architecture_patterns
description: Six TUI-runtime patterns — modal overlays, global hotkeys over view-local data, display-clip markers, one hint source of truth, the commit-storm coalescer, and cancel-vs-abort in the prompt queue
metadata:
  type: project
---

All under `src/application/ui/tui/` — the outermost layer where React and node timers are allowed.

## 1. Modal overlays: per-view inline vs App-Layout-level

- **Per-view inline** — the view renders `{ui.helpOpen ? <HelpOverlay /> : <body>}` inside `ViewShell`'s
  scroll region. Reach for it when the overlay needs view-specific data only available inside `Body`.
- **App-Layout-level** — `App.tsx`'s `Layout` handles the overlay before the routed view. Reach for it
  when the overlay is gated on global state (e.g. `selection.sprintId !== undefined`) and should behave
  like a true modal, covering banner + view chrome with no list-cursor / scroll-region key races behind
  it. Roughly 3 files touched instead of every view, and it dodges collisions between a letter hotkey and
  a ScrollRegion using the same letter.

**The Layout no longer swaps children out** — it wraps them in `display: overlayOpen ? 'none' : 'flex'`
so they stay MOUNTED (list cursors and expanded cards survive the round trip), and every view-level
`useInput` gates on `ui.modalOpen` instead of unmounting. **Consequence to remember: a hidden subtree
measures 0×0 via `measureElement`.** Any component reacting to its own measurement needs a
zero-measurement guard, or opening an overlay silently resets it — that was the ScrollRegion
scroll-to-top bug, fixed by ignoring a zero-height viewport reading in the layout effect.

## 2. A global hotkey over view-local data: ref-registered provider on UiState

The `y` (yank) hotkey copies a markdown summary of the focused task to the clipboard, but the data is
execute-view-local. `UiStateApi.setActiveTaskSummaryProvider(provider | undefined)` +
`getActiveTaskSummary()` store the closure in a **`useRef`, not `useState`**, so the execute view can
swap it on every bucketed-data change without re-rendering every UiState consumer. The view registers in
a `useEffect` and unregisters on cleanup; the global handler in `use-global-keys.ts` calls the provider,
copies, and emits a 2s banner through the existing `banner-show` / `banner-clear` pipeline.

Supporting pieces: `integration/io/clipboard.ts` (platform-detecting writer — `pbcopy` / `wl-copy` /
`xclip -selection clipboard` / `clip.exe`; returns `Result<void, ClipboardError>`, never throws,
injectable `Spawn`) and `runtime/render-active-task-summary.ts` (pure `TaskBucket` → markdown).

**How to apply:** any other global hotkey operating on view-local data follows the same ref-based
registration. Never store per-view computed data in context STATE — every consumer re-renders per frame.

## 3. Display-clip markers: truncate at the display boundary, never at persistence

Tokens in `theme/tokens.ts`: `glyphs.clipEllipsis` (`…`) for single-line trims,
`glyphs.collapseExpand` (`▼ more`) for a multi-line collapse WITH an expand hotkey. An informational
multi-line elision with no expand affordance uses `… N more` / `… N earlier X` — same glyph, no
affordance hint.

**The invariant: a clipped value without a marker is a bug, not a style choice.** Every new clip site
(slice / substring / charwise truncate) appends one of the tokens. Ink's `wrap="truncate-end"` already
appends `…` via `cli-truncate`, so it is compliant by default. Do not clip on the persistence side —
the full body lives in `<sprintDir>/logs/`. Pinned by
`tests/integration/application/ui/tui/components/display-clip-markers.test.tsx`.

**Layer note:** the chains layer cannot import from `application/ui/`, so a flow leaf emitting a
clip-marked event inlines a local `CLIP_ELLIPSIS = '…'` with a comment pointing at the TUI token.
**Clip unit** at the setup-script tail emitter is JS `String.prototype.length` (UTF-16 code units),
documented inline — grapheme clipping via `Intl.Segmenter` is overkill for shell stdout, but revisit it
if user-authored prose ever goes through a banner-class surface.

## 4. One source of truth for advertised keys

A view's advertised keys and its handlers share ONE source: `useViewHints([...])`, rendered by the
router's StatusBar, with `ViewHint.enabledWhen` gating individual visibility (the provider filters
`enabledWhen === false`; `undefined`/`true` always show). **Prefer a static array with `enabledWhen`
flags over conditional `...(cond ? [hint] : [])` spreads.**

Advertising a key whose handler is gated lies to the operator — the design system's "any undocumented
key is a bug" has the inverse: an advertised dead key is equally a bug.

**How to apply — when gating a hint, hunt for a SECOND ungated advertisement.** Several views carried an
inline dim body-footer `<Text>` re-listing the same keys; that footer does not respect `enabledWhen` and
re-asserts the key ungated. Remove it, keeping only non-key content like the item count, so the hint
strip is the only advertisement. A footer listing ONLY always-available nav chords is fine. Tests assert
against the rendered StatusBar (`frame.toContain('add ticket')` / `.not.toContain('e rename')`), which
also catches a stray body-footer duplicate.

## 5. The commit-storm coalescer

The TUI OOM under a long DEBUG-floor run is a **React commit storm, not a retained leak** (every buffer
was already `.slice(-limit)` capped). Mechanism: each stream-json line → many `level:'debug'` bus events
→ `useSinkStream` did `setItems(prev => [...prev, v])` per emit → one React commit per line. Ink
throttles stdout writes (~30fps) but NOT commits, so per-commit Yoga layout + Output allocation ran
unthrottled and V8 OOM'd mid-commit.

`coalesced-buffer.ts` is a pure factory
`createCoalescedBuffer<T>({limit, flushMs?, onFlush, initial?, clearOnFlush?})`. It accumulates pushes
and applies `slice(-limit)` ONCE per flush-or-overflow — the per-push `[...prev, v]` spread was the heap
churn. One unref'd `setInterval`, plus `flushNow()`, `discard()` (empties the window WITHOUT `onFlush`,
resets dirty) and an idempotent `stop()`. `flushMs` defaults to 60 (~16fps, under Ink's write throttle),
floored at 16.

**Two flush modes — this is the subtle part.** Default `clearOnFlush:false` is ROLLING-WINDOW REPLACE:
the window persists across flushes and `onFlush` gets the full trailing window each tick, which is
correct for `setItems` consumers because setItems replaces. **A forwarder whose `onFlush` RE-EMITS each
value into a downstream sink MUST set `clearOnFlush:true`** (delta mode). A rolling window plus re-emit
re-emits prior batches every tick, re-growing the sink — the very OOM being fixed.

- `use-coalesced-buffer.ts` — thin hook; the subscribe seam is captured in a ref (a fresh arrow each
  render must not churn the subscription); deps array is caller-owned; seeds initial + `flushNow()` on
  mount so replay paints in one frame; cleanup is `unsub(); buf.flushNow(); buf.stop()`. The `useState`
  lazy initializer already holds `initial.slice(-limit)`, so the effect's explicit re-seed is gated
  behind a `mountedRef` — skipped on first run, still applied on a genuine deps-change re-run.
- `use-sink-stream.ts` / `use-event-bus.ts` are reimplemented on the hook with PUBLIC SIGNATURES
  UNCHANGED, plus an optional test-only `flushMs` hatch.
- `launch.ts`'s `createLogForwarder`: gate at ingest (`passesLogLevel` against the live gate) → push
  admitted → coalescer (`clearOnFlush:true`) re-emits the batch into `logBus` in one synchronous turn.
  The heap-watchdog `onCritical` calls `forwarder.discard()` — NOT `flushNow()`, which would re-emit the
  held window into logBus right before clearing it — then `harnessBus.clear(); logBus.clear();`.

**The EventBus/BusSink contract MUST stay synchronous fire-and-forget — coalescing is purely
consumer-side.** Any future hot TUI subscription routes through `useCoalescedBuffer` rather than
per-event `setItems`. The launch.ts forwarder is the ONLY UI-floor chokepoint: providers publish every
stream-json line verbatim, `createEventBusLogger` is a producer not a filter, and the events.ndjson sink
writes verbatim regardless of floor.

**Second, log-floor-INDEPENDENT amplifier:** `session-manager.notify()` fires per leaf `step` into the
unguarded `useSessions`/`useSession`, consumed by the always-mounted StatusBar. Guarded with a
status-diff signature — only `setState` when the signature changed, so trace-only steps are swallowed.
**The signature MUST include pinnedSprintId + pinnedSprintLabel, not just status:** `setPinnedSprint`
changes no status, so a status-only signature drops the notify and the execute view shows a stale
undefined sprint. Current shape:
`${status}|${error?1:0}|${pinnedSprintId ?? ''}|${pinnedSprintLabel ?? ''}` via a shared `sigOf()`. **Do
NOT add `trace`** — the live rail stays current via the shared-mutable trace array plus sibling
chainEvents re-render, and adding trace reintroduces the per-step storm.

**Test conventions:** the pure coalescer test uses `vi.useFakeTimers()` (no React in that layer).
Rendered TUI hook tests MUST use REAL timers and drain past `flushMs` (e.g. `flushMs:20`, drain ~60ms) —
never fake timers inside an ink-testing-library render. A render-count probe should assert ~1–2 commits
for 50 emits, not 50.

## 6. Prompt-queue cancel is a plain Error, never AbortError

The prompt queue distinguishes user-cancel from chain-abort by error CLASS, and that is what makes
"re-throw AbortError, swallow the rest" safe in any `.catch` wrapping a prompt promise.

- esc-cancel of a single prompt → `prompt-host.tsx` `rejectHead(new Error('cancelled by user'))` — a
  PLAIN `Error`.
- TUI shutdown → `launch.ts` `queue.drain(new Error('TUI shutting down'))` — also plain.
- `AbortError` (code `aborted`) is ONLY the chain-runtime cancellation error; nothing in the prompt path
  produces it.

So the project rule "a blanket promise `.catch` MUST re-throw AbortError" does not break the silent
esc-cancel swallow in `use-edit-field.ts`.

**How to apply:** gate the swallow on `instanceof AbortError` in any `.catch` around
`queue.enqueue(...)` or `openEditPrompt(...)`. **The two seams are independent** — `use-edit-field.ts`
guards the edit TEXT prompt and `field-editors.ts` guards the field-PICKER choice prompt; fixing one
does not make the other redundant.

Related: [[seams_chain_runner_core]], [[seams_tui_test_gotchas]].
