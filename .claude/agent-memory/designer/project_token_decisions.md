---
name: token-decisions
description: Token decisions that are easy to undo by accident: focusBar codepoint, colourless unknownGlyph, bare '?' in the token-budget card, up/down-only hint strips, joinCounts separator
metadata:
  type: project
---

- **`glyphs.focusBar` is U+258D (left three-eighths block), not U+258E.** Pin `0x258d` in token tests.
- **`glyphs.unknownGlyph = '?'` is deliberately colourless.** `VERDICT_PRESENTATION.unknown` in
  `evaluator-failure-panel.tsx` must keep `color` ABSENT so `dimensionRows` falls through to `{ dim: true }`; a colour
  would report an undetermined verdict as pass/fail.
- **`token-budget-card.tsx` keeps a bare `'?'`** for a missing token count: a placeholder for an absent number, not a
  status glyph, so it is intentionally not `unknownGlyph`.
- **Hint strips advertise `↑/↓` only** (DESIGN-SYSTEM §6.4). `useViewKeys` sites take `keys: ['↑', '↓']`,
  `useViewHints` sites take `keys: '↑/↓'`. Do not spread `listMoveHint` into either: `useViewKeys`'s `keys` holds
  literal input strings the dispatcher matches.
- **`outcome-card.tsx` `joinCounts` emits `label N · label N`**, matching every sibling line in that card.

**Why:** `theme/tokens.ts` is the single source of visual truth; inline glyphs and raw column numbers defeat it.
