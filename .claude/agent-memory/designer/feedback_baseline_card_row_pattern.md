---
name: feedback_baseline_card_row_pattern
description: Baseline-health card row design pattern — one row shape, status on sub-line, compact all-clean variant
metadata:
  type: feedback
---

Keep one row pattern throughout status cards: glyph + label on headline; status phrase
and detail on dim sub-lines. Never put status inline after the label on the same line.

**Why:** Inline `<label> · <status>` patterns always risk wrapping at narrow card widths
(CONTEXT_WIDTH = 28 cols, 24 usable after borders/padding). When status is a sub-line the
label is always a clean single line. Discovered during baseline-health card redesign (May 2026).

**How to apply:**

- `RowData.status` → first dim sub-line below the headline (not inline).
- `RowData.sublines` → additional dim lines (elapsed, counts, etc.).
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
