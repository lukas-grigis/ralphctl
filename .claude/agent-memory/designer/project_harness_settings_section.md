---
name: project_harness_settings_section
description: T15 harness section in TUI settings — new fields + readonly-map field kind for escalationMap
metadata:
  type: project
---

The harness section (`settings-view-model.ts` `harnessFields`) now includes:

- `harness.escalateOnPlateau` — `select` field (`true`/`false`), hint: "Gates ALL failure-driven escalation…"
- `harness.skipPreVerifyOnFreshSetup` — `select` field (`true`/`false`), hint: "Asserts your setup script verifies the tree…"
- `harness.escalationMap` — new `readonly-map` field kind; renders `<from> → <to>` entries or dimmed "none — defaults apply"

A new `readonly-map` field kind was added to `EditableField` union in `settings-view-model.ts`. It carries `entries: ReadonlyArray<{ from, to }>` and a summary `current` string. The `settings-view.tsx` key handler returns early (`return`) for `readonly-map` so ↵/e is a no-op — the hint line guides to CLI syntax.

The hint for `escalationMap` in `harness-row.tsx` is the constant `ESCALATION_MAP_CLI_HINT`:
`Read-only here — edit via: ralphctl settings set harness.escalationMap.<fromModel> <toModel>`

This was verified against `apply-key.ts` which handles `harness.escalationMap.<fromModel>` explicitly.

**Why:** The plan mandated read-only display + CLI hint for escalationMap v1; full inline map editor deferred.

**How to apply:** Any future field that should be navigable (cursor passes through it, hint is visible) but not editable in the TUI should use `kind: 'readonly-map'` or a similar guard in the `settings-view.tsx` key handler. Do not use `readonly: true` on the section — that would hide all fields; per-field readonly is the right granularity.
