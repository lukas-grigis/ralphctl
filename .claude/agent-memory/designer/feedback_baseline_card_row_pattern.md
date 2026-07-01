---
name: feedback_baseline_card_row_pattern
description: Baseline-health card row design pattern — one row shape, status inline after label, one line per indicator, compact all-clean variant
metadata:
  type: feedback
---

Keep one row pattern throughout status cards: glyph + label, then the single most important
detail token shown dim inline after the label — one line per indicator (no multi-line
stacking). error/warning/pending rows show the status phrase; ok rows show the first
subline (elapsed).

**Why:** Inline `<label> <detail>` risks wrapping at narrow card widths (CONTEXT_WIDTH = 28
cols, 24 usable after borders/padding). Wrapping is avoided not by stacking sub-lines but by
keeping labels short (≤14 chars) and rendering only ONE short detail token per row. Discovered
during baseline-health card redesign (May 2026).

**How to apply:**

- `RowData.status` → the inline detail token for error/warning/pending rows (shown after the
  label, not on a sub-line).
- `RowData.sublines` → only the first entry is ever rendered; shown inline for ok rows
  (elapsed), not as a stacked line.
- Label strings: keep ≤14 chars. "Pre verify" / "Post verify" / "Attrib" / "Setup" are safe.
- Compact all-clean variant: build a single plain string (`✓Stp ✓Pre ✓Post ✓Att`) rather than
  multiple `<Text>` nodes in a flex row — ink word-wraps between sibling `<Text>` nodes, which
  breaks abbreviated labels that look like individual words.

**Title-bar accent pattern (two rules):**

- Error: title reads `"<Component> · <label> failed"` in error tone.
- All-clean (every row `ok`): title reads `"<Component> · clean"` in success tone.
- Mixed ok+pending: plain title, no suffix — "clean" must NOT fire for partial states.

**Fluid width at xxl:** context column width should be `fluid(columns, { min: 28, max: 36, ratio: 0.14 })`.
Pass as a `width` prop from execute-view; the card never hardcodes its own width.
