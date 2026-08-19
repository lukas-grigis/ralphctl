---
name: design-system-drift-297
description: Ticket #297 fixes — new glyph tokens (focusBar/barFilled/barEmpty/unknownGlyph), breakpoint tokens in use-responsive-layout, j/k dropped from hint strips, joinCounts separator; plus owed DESIGN-SYSTEM.md §2.2 doc update
metadata:
  type: project
---

Ticket #297 (2026-08-19, branch `feature/refactor-docs-tickets`) closed four design-system departures.
Decisions worth keeping:

- **`glyphs.focusBar` is U+258D (left three-eighths block), not U+258E.** The sprint-picker focus rail
  literal was `▍`. An initial token test asserted `0x258e` and failed — pin `0x258d`.
- **`glyphs.unknownGlyph = '?'` is deliberately colourless.** `evaluator-failure-panel.tsx`'s
  `VERDICT_PRESENTATION.unknown` must keep `color` ABSENT so `dimensionRows` falls through to
  `{ dim: true }`. Adding a colour would report an undetermined verdict as pass/fail.
- **`token-budget-card.tsx` still renders a bare `'?'`** for a missing token count (a placeholder for an
  absent number, not a status glyph). Intentionally NOT switched to `unknownGlyph` — different meaning.
- **Hint strips advertise `↑/↓` only** (DESIGN-SYSTEM §6.4). `useViewKeys` sites take `keys: ['↑', '↓']`
  (joined to `↑/↓`); `useViewHints` sites take `keys: '↑/↓'`. `listMoveHint` is NOT spread into either —
  `useViewKeys`'s `keys` array holds literal input strings the dispatcher matches, and the already-correct
  views write the literal. `project-detail-view` and `settings-view` label the same hint `navigate`, so
  `move` is not the single label — only the keys spelling converged.
- **`outcome-card.tsx` `joinCounts` now emits `label N · label N`** (bullet as separator), matching every
  sibling line in that card. The old `label ·N  label ·N` form had no design-system basis.

**Why:** theme/tokens.ts is the single source of visual truth; inline glyphs and raw column numbers
defeat it.

**How to apply:** reuse these tokens rather than re-inlining. Two inline `█` remain at
`prompts/text-prompt.tsx` and `prompts/text-area-prompt.tsx` as the caret block — a different semantic;
a `caretBlock` token is the proposed follow-up.

**OWED FOLLOW-UP:** `.claude/docs/DESIGN-SYSTEM.md` §2.2's glyph table does not yet list the four new
tokens (that file was outside the ticket's owned-files list). Add them the next time that doc is touched.
