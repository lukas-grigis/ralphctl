---
name: project_context_window_visibility
description: Context-window size (200K / 1M) visible in all model selectors and execution surfaces; domain helper is the single source of truth (integration adapter re-exports it, #226)
metadata:
  type: project
---

Context-window labels added to every UI surface that shows or selects a model (Jun 2026, worktree ctxwin).

**Why:** Users couldn't tell whether a run was on the 200K or 1M window. All picker options now carry
`claude-sonnet-4-6  ·  200K` or `claude-opus-4-8[1m]  ·  1M` as label suffixes; unknown/Copilot/Codex
models gracefully degrade (no suffix added).

## New domain helper

`src/domain/value/settings-models/context-window.ts` — pure, no I/O.

- `contextWindowFor(model): number | undefined`
- `contextWindowLabel(model): string | undefined` → `"200K"` / `"1M"` / undefined

`src/integration/ai/providers/_engine/context-window.ts` re-exports `contextWindowFor` from here
(unified in #226) — this domain module is the single source of truth for the model → window map. A new
model entry only needs to be added to `CONTEXT_WINDOW` here.

**Layer rationale:** `application/` layer cannot import `integration/_engine/` adapter — domain is the
correct home for model IDs and their properties.

## Annotation format

`<model-id>  ·  <window>` (two spaces around the middot token `glyphs.bullet`).
Composed with suspended note: `claude-fable-5[1m]  ·  1M  (suspended)`.
`glyphs.bullet` from tokens.ts — never hardcoded inline.

## Modified surfaces

- **`settings-editor.tsx`** — `annotateModelLabel()` helper used for all three picker kinds: model
  select, escalation FROM picker, escalation TO picker. One helper, three call sites.
- **`flows-customize-picker.ts`** — `modelChoice()` updated. Added tokens import for `glyphs.bullet`.
- **`execute-view-internals/header-card.tsx`** — `RoleLine` (both roles) + single-model fallback line.
  `contextWindowLabel(model)` called inside the component, rendered as `· 200K` dim text after the model.
- **`token-budget-card.tsx`** — `fmtTokens` fixed for ≥1M (was `1000k`, now `1M`); model + window label
  added as a dim descriptor line in the Context group, omitted when model is undefined.
- **`tasks-panel-internals/format.ts`** — `fmtTokens` same ≥1M fix for consistency.

## Tests updated

- New: `tests/unit/domain/value/settings-models/context-window.test.ts`
- Updated: `tests/integration/application/ui/tui/components/token-budget-card.test.tsx` (+3 cases)
- Updated: `tests/integration/application/ui/tui/views/flows-view.customize-picker.test.tsx`
  — Added `buildExpectedModelLabel()` helper, updated 6 assertions to use new format, changed
  2 label-based lookups to value-based lookups (`o.value === otherModel`).

**How to apply:** When adding a new model to CLAUDE_MODELS, add it to `CONTEXT_WINDOW` in
`src/domain/value/settings-models/context-window.ts` if its window size is known. The integration adapter
(`integration/ai/providers/_engine/context-window.ts`) re-exports this table (#226), so no second file
update is needed.
