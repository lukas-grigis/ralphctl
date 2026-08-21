---
name: seams_tui_test_gotchas
description: Test gotchas that make a TUI or filesystem regression test pass for the wrong reason — batched stdin, the 100x24 stub, spinner flap, vacuous scroll tests, the wide-layout blind spot, and traversal-sandbox poisoning
metadata:
  type: project
---

Each of these produced a green test against buggy code. When one applies, prove non-vacuity by
re-running the test with the fix reverted.

## ink-testing-library

1. **`stdin.write('draft')` arrives at `useInput` as ONE input string, not five keystrokes.** A handler
   matching `input === 'd'` never fires, so a test that types a whole word "passes" against the buggy
   code — this is exactly how a single-letter-dismiss regression test sailed past the bug it was written
   to reproduce. **Any test asserting "typing X does / does not trigger single-letter hotkey Y" must
   write char-by-char with a `tick()` between calls.** Batched writes are fine only when asserting the
   resulting buffer contents.

2. **The stdout stub reports `columns = 100` and NO `rows`**, so `useTerminalSize` falls back to 24.
   Derive expected viewport numbers from those two rather than guessing.

3. **Whole-frame equality assertions flap on the StatusBar's braille spinner** — the pinned footer
   animates on its own timer, so `expect(lastFrame()).toBe(before)` fails for reasons unrelated to the
   behaviour under test. Normalise the braille block (`/[⠀-⣿]/g`). Do NOT instead split the frame on a
   horizontal rule: ViewShell paints a rule under the banner too, so "everything before the first rule"
   is just the banner line and the assertion goes vacuous.

4. **Page-scroll behaviour is untestable without a fixed-height wrapper.** A view rendered bare measures
   its `ScrollRegion` viewport at full content height ⇒ `maxOffset === 0` ⇒ every scroll key
   early-returns, so a "keys must not scroll the page" test passes with or without the fix. Wrap in
   `<Box height={N}>` and assert that something below the fold is absent.

5. **The 100-column stub hides every WIDE-layout regression on the Execute view.** `ImplementLayout` is
   a two-branch compositor: at ≥140 cols (`layout.sidebarLayout`) it builds its OWN `TasksPanelHost`
   inside `ImplementMainArea`; below 140 it renders the caller's pre-built `tasksPanel` node via
   `ExecuteLayout`. A handler threaded only into the pre-built node is a silent no-op on any real wide
   terminal while the width-independent footer keeps advertising it — and every Execute-view test runs
   at the default 100 cols. **When adding a prop to the tasks panel, thread BOTH branches and A/B the
   behaviour at 160 AND 100 cols**, driving widths through `useResponsiveLayout({ columns })` props or
   mocking `useTerminalSize` the way `execute-view-width-regimes.test.tsx` does.

## Row-count windowing invariant

Any surface that slices `lines[offset, offset + bodyRows]` and derives `maxOffset` from `lines.length`
needs one array entry to equal one terminal row. Artifacts (`evaluation.md` critique, `progress.md`
notes) are written one PARAGRAPH per line, so entry count and painted row count diverge — `maxOffset`
collapses to 0, `useDocumentScroll` early-returns on every key, the footer disappears and the tail is
unreachable. Fix by pre-wrapping; `truncate-end` alone loses prose in a read-only prose viewer, so keep
it only as the backstop.

## Path-traversal regression tests really escape the sandbox

Test-first on a traversal defect means the failing run genuinely writes outside the fixture. A name like
`../../../../tmp/pwned` under a `mkdtemp` session dir landed a real file in `$TMPDIR/tmp/pwned`, which
then made the post-fix `expect(existsSync(escapeTarget)).toBe(false)` assertion fail forever until the
artifact was deleted by hand.

**Why:** a traversal target that leaves the unique `mkdtemp` dir resolves to a SHARED path, so the
escape assertion is not run-isolated — a leftover from an earlier run masks a regression in both
directions.

**How to apply:** build the fixture as `root = mkdtemp(...)` + `session = root/repo`, and pick traversal
depths that resolve back inside `root` (`../escape`, `../../../escape-far`). The escape is still real
(outside `session`) but the asserted path stays unique per run.

Related: [[seams_tui_architecture_patterns]], [[project_slugged_data_layout_resolver]].
