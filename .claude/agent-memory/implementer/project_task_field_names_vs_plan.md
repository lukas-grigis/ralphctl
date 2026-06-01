---
name: task-field-names-vs-plan
description: Task entity uses name/dependsOn, NOT title/blockedBy — plan docs use the latter loosely; map them
metadata:
  type: project
---

The `Task` entity (`src/domain/entity/task.ts`) field names differ from how design/plan docs casually refer to them:

- Prose field is **`name`** (+ optional `description`) — there is NO `title` field.
- Dependency edges are **`dependsOn: readonly TaskId[]`** — there is NO `blockedBy` field on `Task`.
- Ordering field is **`order: number`** (1-indexed, set by `parseTaskList` as `i + 1`).

**Why:** Design/plan docs and CLAUDE.md both reference `Task.blockedBy` and "title/description" — those are loose/aspirational names. `validateTaskGraph` / `nextAvailableTask` / `scheduleIntoWaves` all operate on `dependsOn`.

**How to apply:** When implementing a spec that says "title" → read `task.name`; "blockedBy" → read `task.dependsOn`. `deriveTaskKind` scans `name + description`. The `makeTodoTask` fixture (`tests/fixtures/domain.ts`) accepts `name`, `order`, `dependsOn` overrides but NOT `description` (use `createTask` directly, or cast a `{name, description}` literal as `Task` for pure-classifier tests since only those two fields are read).
