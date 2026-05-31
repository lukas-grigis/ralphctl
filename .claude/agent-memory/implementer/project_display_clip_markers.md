---
name: project-display-clip-markers
description: Audit-[03] display-clip marker tokens + rule — `…` for single-line trims, `▼ more` for multi-line collapses with expand affordance
metadata:
  type: project
---

Wave 9 / audit-[03] landed the truncation policy: **truncate at the display boundary, never at persistence**. Tokens
live at `src/application/ui/tui/theme/tokens.ts`:

- `glyphs.clipEllipsis` (U+2026 `…`) — single-line trims.
- `glyphs.collapseExpand` (`▼ more`) — multi-line collapses with an explicit expand hotkey (e.g. press `e`).

Informational multi-line elisions WITHOUT an expand affordance use `… N more` / `… N earlier X` (still the clipEllipsis
glyph, just no affordance hint). The criteria block in tasks-panel is the canonical `▼ more` pattern; the subStep /
eval / signal / orphan rows in tasks-panel are the canonical `… N earlier X` pattern.

**Layer note:** the chains layer cannot import from `application/ui/`. When a flow leaf emits a clip-marked event (e.g.
setup-script-runner's tail-rows on the bus), it inlines a local `CLIP_ELLIPSIS = '…'` constant with a comment referring
to the TUI token.

**Why:** the audit invariant — "a clipped value without a marker is a bug, not a style choice." The operator must always
know they're looking at truncated data, not the full record. Pin the rule via the dedicated test file
`tests/integration/application/ui/tui/components/display-clip-markers.test.tsx`.

**How to apply:** every new TUI clip site (slice / substring / charwise truncate) MUST append one of the tokens. Ink's
`wrap="truncate-end"` already appends `…` via `cli-truncate` — so it's compliant by default. Persistence-side clips:
don't do them; the full body lives in `<sprintDir>/logs/`.

**Banner-clip unit:** JS `String.prototype.length` (UTF-16 code units) is the explicit unit at the setup-script tail
emitter — documented inline. Grapheme clipping via `Intl.Segmenter` is overkill for shell stdout. If you ever surface
user-authored prose through a banner-class surface, revisit and switch to graphemes.

Related: [[project_chain_deps_reachability_fence]] (architectural fences also enforced via ESLint patterns).
