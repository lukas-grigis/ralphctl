---
name: tui-row-windowing-and-key-test-gotchas
description: Row-count windowing invariant for the document overlays + two ink-testing-library gotchas (batched stdin writes, 100x24 stub terminal) that silently make TUI keyboard tests pass for the wrong reason
metadata:
  type: project
---

Two things that cost real debugging time on the TUI hardening batch (2026-08-18).

**1. `stdin.write('draft')` arrives at `useInput` as ONE input string, not five keystrokes.**
A handler that matches `input === 'd'` never fires for a batched write, so a test that types a whole
word "passes" against the buggy code. Write one character per call with a `tick()` between them when
the behaviour under test is a single-key handler racing a prompt.

**Why:** the `StatusBanner` `d`-dismiss gate regression test passed before the fix was applied; the
batched write had sailed past the very bug it was meant to reproduce.

**How to apply:** any test asserting "typing X does / does not trigger single-letter hotkey Y" must
write char-by-char. Batched writes are fine only when asserting the resulting buffer contents.

**2. ink-testing-library's stdout stub reports `columns = 100` and NO `rows`** — `useTerminalSize`
falls back to 24. Derive expected viewport numbers from those two, don't guess.

**3. Row-count windowing invariant.** Any surface that slices `lines[offset, offset + bodyRows]` and
derives `maxOffset` from `lines.length` needs one array entry == one terminal row. Artifacts
(`evaluation.md` critique, `progress.md` note) are written one paragraph per line, so the entry count
and the painted row count diverge — `maxOffset` collapses to 0, `useDocumentScroll` early-returns on
every key, the footer disappears and the tail is unreachable. Fix is pre-wrap (not `truncate-end`
alone, which loses prose in a read-only prose viewer); `truncate-end` stays as the backstop.

Related: [[project_view_hint_single_source]], [[project_trustworthy_firstrun_waves12_2026-08-14]].
