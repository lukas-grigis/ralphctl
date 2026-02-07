---
name: data-storage
description: Data directory structure, file layout, and schema sync rules
---

# Data Storage Layout

## Directory Structure

```
ralphctl-data/              # Git-ignored, all persistent data
├── config.json             # Current/active sprint tracking
├── projects.json           # Project definitions
└── sprints/<sprint-id>/    # e.g., 20260204-154532-api-refactor/
    ├── sprint.json         # Sprint metadata + tickets
    ├── tasks.json          # Task array
    ├── progress.md         # Append-only log
    ├── refinement/         # Created by `sprint refine`
    │   └── <ticket-id>/
    │       ├── refine-context.md             # Prompt/context sent to Claude
    │       └── requirements.json            # Claude's refined requirements
    └── planning/           # Created by `sprint plan`
        ├── planning-context.md  # Prompt/context sent to Claude
        └── tasks.json           # Claude's generated tasks (before import)
```

## Key Files

| File            | Purpose                                       |
| --------------- | --------------------------------------------- |
| `config.json`   | Tracks current sprint ID and active sprints   |
| `projects.json` | All project definitions with repositories     |
| `sprint.json`   | Sprint metadata, status, and embedded tickets |
| `tasks.json`    | Task array with status, dependencies, steps   |
| `progress.md`   | Append-only markdown log of sprint activity   |

## Schema Sync

JSON schemas in `/schemas/` must be kept in sync with Zod schemas in `src/schemas/index.ts`. When modifying data structures, update both locations.
