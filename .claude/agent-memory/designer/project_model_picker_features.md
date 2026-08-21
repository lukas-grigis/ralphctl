---
name: project_model_picker_features
description: Model-selection UX — context-window annotation on every model surface, and visible effort inheritance on a model-only change
metadata:
  type: project
---

Both features live on the customize/model-picker surfaces (`flows-customize-picker.ts`,
`settings-editor.tsx`, `header-card.tsx`, `token-budget-card.tsx`).

## Context-window annotation

Every surface that shows or selects a model annotates the window size, because operators could not tell
a 200K run from a 1M one.

- **Single source of truth:** `src/domain/value/settings-models/context-window.ts` — pure, no I/O.
  `contextWindowFor(model)` and `contextWindowLabel(model)` (→ `"200K"` / `"1M"` / undefined) over the
  `CONTEXT_WINDOW` table. `integration/ai/providers/_engine/context-window.ts` re-exports it. A new
  model with a known window needs ONE edit, in the domain table.
- **Layer rationale:** `application/` cannot import an `integration/_engine/` adapter, so model ids and
  their properties belong in domain.
- **Format:** `<model-id>  ·  <window>`, two spaces around `glyphs.bullet` from tokens.ts — never a
  hardcoded middot. Composes with the suspended note: `claude-fable-5[1m]  ·  1M  (suspended)`.
- Unknown / Copilot / Codex models degrade gracefully — no suffix.
- `fmtTokens` renders ≥1M as `1M`, not `1000k`, in both `token-budget-card.tsx` and
  `tasks-panel-internals/format.ts`.

Surfaces: `settings-editor.tsx` uses one `annotateModelLabel()` helper for all three picker kinds
(model select, escalation FROM, escalation TO); `flows-customize-picker.ts`'s `modelChoice()`;
`header-card.tsx`'s `RoleLine` + single-model fallback; `token-budget-card.tsx`'s Context group.

## Effort inheritance made visible on a model-only change

Silent inheritance was a real cost incident: picking a cheaper model kept the previously-saved `xhigh`
effort, producing the worst wall-clock of any configuration. Deliberate choices must be respected, and
inherited ones must be visible.

When the model changes but the provider does not, the effort step's keep-default label names the
concrete inherited value and its source:

| Situation          | Label                                                |
| ------------------ | ---------------------------------------------------- |
| Per-row effort set | `Keep default (xhigh — saved row)`                   |
| Only global effort | `Keep default (high — global)`                       |
| Neither            | `Keep default (auto)`                                |
| Provider changed   | `Keep default` (old effort vocabulary may not apply) |
| Model unchanged    | `Keep default (xhigh)`                               |

The `modelChanged` flag (`modelAns.value !== KEEP && modelAns.value !== defaultRow.model`) gates the
label path inside `customizeRow`. **The override shape is deliberately unchanged:** keeping `__keep__`
still yields `effort: undefined` in the override, so `mergeImplementRole`'s `override.effort ??
base.effort` never fires unless the user explicitly picks a level. That is correct — keep-default after
a model-only change leaves effort absent, and the launcher resolves it through the standard chain
(per-row → global → CLI built-in), clearing the stale value.
