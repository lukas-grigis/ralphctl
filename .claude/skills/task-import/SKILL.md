---
name: task-import
description: 'Task import JSON schema for `ralphctl task import <file.json>`. Use when authoring or validating an import file, debugging import validation errors, or wiring a planner/generator that emits tasks for ralphctl. Covers required fields, `blockedBy` local-ID resolution, `repoId`/`ticketId` constraints, and `extraDimensions`.'
when_to_use: 'When you are generating or hand-writing a JSON file to feed into `ralphctl task import`, or when diagnosing "Invalid task format" / "Dependency validation failed" errors from that command.'
---

# Task Import Format

Source of truth: `ImportTaskSchema` in `src/domain/models.ts`. The command lives at
`src/integration/cli/commands/task/import.ts`.

## JSON format

Input is a JSON array of task objects:

```json
[
  {
    "id": "1",
    "name": "Add login endpoint",
    "description": "JWT-based session issue endpoint",
    "steps": ["Define route", "Issue signed token", "Wire into router"],
    "verificationCriteria": ["200 on valid creds", "401 on bad creds"],
    "repoId": "a1b2c3d4",
    "ticketId": "ttk77xyz",
    "extraDimensions": ["Security"]
  },
  {
    "id": "2",
    "name": "Add logout endpoint",
    "repoId": "a1b2c3d4",
    "blockedBy": ["1"]
  }
]
```

## Field reference

| Field                  | Type     | Required | Notes                                                                                                                                   |
| ---------------------- | -------- | :------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | string   |   yes    | Non-empty task name                                                                                                                     |
| `repoId`               | string   |   yes    | Must match a repository on the sprint's project. Drives `projectPath` for execution.                                                    |
| `id`                   | string   |    no    | Local ID used only to wire `blockedBy` within this file. Rewritten to the real task UUID8 on import.                                    |
| `description`          | string   |    no    |                                                                                                                                         |
| `steps`                | string[] |    no    | Free-form step list the executor agent sees                                                                                             |
| `verificationCriteria` | string[] |    no    | Grading contract surfaced to the evaluator                                                                                              |
| `ticketId`             | string   |    no    | Must reference an existing ticket in the current sprint                                                                                 |
| `blockedBy`            | string[] |    no    | Each entry is a **local `id`** of an earlier task in the same file — not a real task UUID                                               |
| `extraDimensions`      | string[] |    no    | Non-default evaluator dimensions stacked on top of the floor four (Correctness/Completeness/Safety/Consistency), e.g. `["Performance"]` |

## Validation rules (enforced by the importer)

- `repoId` is required on every task. Sprints are scoped to one project; the repo must belong to that project.
- `blockedBy` may only reference `id`s of tasks defined **earlier in the array**. Forward references fail validation.
- `ticketId`, if provided, must exist on the current sprint's ticket list.
- Local `id`s are rewritten to real task UUIDs during import; the mapping is resolved in a second pass under a file lock.
- The sprint must be in `draft` or `active` status — `closed` sprints reject imports.
- Empty arrays are rejected with "No tasks to import".

## Running

```bash
ralphctl task import ./tasks.json
```

On failure the command prints field-level Zod issues (`path.to.field: message`). Re-run after fixing and the importer
is idempotent — no partial state is persisted when validation fails before the first-pass `addTask`.
