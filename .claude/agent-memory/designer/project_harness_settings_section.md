---
name: project_harness_settings_section
description: T15 harness section in TUI settings — new fields + editable map-add/map-entry field kinds for escalationMap
metadata:
  type: project
---

The harness section (`settings-view-model.ts` `harnessFields`) now includes:

- `harness.escalateOnPlateau` — `select` field (`true`/`false`), hint: "Gates ALL failure-driven escalation…"
- `harness.skipPreVerifyOnFreshSetup` — `select` field (`true`/`false`), hint: "Asserts your setup script verifies the tree…"
- `harness.escalationMap` — rendered as one `map-add` field ("add a rung") plus one `map-entry` field per existing override; both are fully editable in the TUI, not read-only

The escalation map is edited inline in the TUI via two `EditableField` kinds in `settings-view-model.ts` — `map-add` (an "add a rung" action that walks a two-step FROM→TO model picker) and `map-entry` (one editable row per existing override, offering a target picker plus a "(remove this override)" choice). `activateField` in `settings-view.tsx` (lines 109-118) returns early only for `kind === 'preset'`; every other field, including `map-add`/`map-entry`, routes to `setEditingField`, which mounts `SettingsEditor` (`settings-editor.tsx` lines 132-146 render `EscalationAddEditor` for `map-add` and a `SelectPrompt` for `map-entry`).

The hint for a `map-entry` row in `harness-row.tsx` is the constant `ESCALATION_ENTRY_HINT`:
`Change the escalation target — pick (remove this override) to drop the rung.`

This was verified against `apply-key.ts` which handles `harness.escalationMap.<fromModel>` explicitly.

**Why:** The plan mandated read-only display + CLI hint for escalationMap v1; a later change replaced that with a full inline map editor (`map-add`/`map-entry`), so escalationMap is now edited entirely in the TUI.

**How to apply:** Any future field that should be navigable (cursor passes through it, hint is visible) but not editable in the TUI should add a new `EditableField` kind and guard it in `activateField` (`settings-view.tsx`) the same way `kind === 'preset'` is guarded today. Do not use `readonly: true` on the section — that would hide all fields; per-field readonly is the right granularity.
