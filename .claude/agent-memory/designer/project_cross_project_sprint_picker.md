---
name: project_cross_project_sprint_picker
description: Cross-project sprint picker UX — make S show all sprints grouped by project; t toggles scope; picking auto-sets both project+sprint atomically
metadata:
  type: project
---

## Decision: `S` becomes cross-project by default (Option B)

`PickSprintView` extended (not a new view) to load all sprints + projects and render grouped by project.
A local `scopeAll` boolean (default `true`) controls whether the list is filtered to `selection.projectId`.
`t` key toggles scope inline.

**Why:** Option A (new global chord) forces discovery of a second key. Option C (expandable project rows)
mixes two interaction models. Option B is additive: S used to show your-project's sprints; now shows all,
grouped, with yours first. Experience strictly improves without breaking the current mental model.

**How to apply:** When designing any future multi-project picker (tickets, tasks), use the same grouped-list

- `t`-toggle pattern rather than separate global chords.

## Atomic setter required

`selection.setProject()` currently clears `sprintId` as a side-effect (selection-context.tsx line 64-70).
Picking a cross-project sprint must not go through two separate setter calls — fires onChange twice and
causes a flicker. A new `setProjectAndSprint(projectId, projectLabel, sprintId, sprintLabel)` method on
`SelectionApi` is required for any cross-project pick action.

## Key allocation

`t` — toggle scope (all projects / current project) — free across global, list, execute, tasks-panel maps.
`S` — unchanged; remains the global pick-sprint chord.
`P`, `S` added to `keyboard-map.ts` `globalKeys` (they existed in `use-global-keys.ts` but were missing
from the map — gap filled as part of this work).

## Orphaned sprint handling

Sprints whose `projectId` has no matching project entry (project deleted) render under an
"Unknown project" group with `inkColors.warning` header and `glyphs.warningGlyph` prefix. Not an error,
not hidden — degraded but navigable.

## State snapshot NOT changed

`recentSprints` in `state-snapshot.ts` stays project-scoped — it feeds the home-view inline list which
is intentionally a "what was I just doing on this project" summary. Picker does its own full load.
