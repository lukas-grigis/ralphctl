---
name: project_picker_effort_inheritance
description: T14 effort-inheritance fix in flows-customize-picker.ts — model-only change makes inherited effort visible with source tag
metadata:
  type: project
---

When the user changes the model (same provider) in the customize picker, the effort step's keep-default label now shows the concrete inherited value plus a source tag:

- Per-row effort set: `Keep default (xhigh — saved row)`
- Only global effort: `Keep default (high — global)`
- Neither: `Keep default (auto)`
- Provider changed: `Keep default` (no value shown — old vocabulary may not apply)
- Model unchanged: `Keep default (xhigh)` (existing behaviour, no source tag)

**Why:** The incident produced sonnet @ xhigh (worst wall-clock) when the user intended only a cheaper model. Silent inheritance was the bug. Deliberate choices must be respected.

**How to apply:** The `modelChanged` flag (`modelAns.value !== KEEP && modelAns.value !== defaultRow.model`) gates the new label path in `customizeRow`. The override shape is unchanged — keeping `__keep__` still produces `effort: undefined` in the override, so `mergeImplementRole`'s `override.effort ?? base.effort` fallback is never triggered unless the user explicitly picks an effort level. This is correct: when the user selects keep-default on effort after a model-only change, effort stays absent from the override and the launcher resolves effort via the standard chain (per-row → global → CLI built-in), effectively clearing the stale xhigh.

Test coverage: 4 new tests in `flows-view.customize-picker.test.tsx` under `runCustomizePicker — effort-inheritance visibility (T14)`.
