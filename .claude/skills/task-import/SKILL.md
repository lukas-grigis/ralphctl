---
name: task-import
description: Task import JSON format, field reference, and validation rules
---

# Task Import Format

## JSON Format

```json
[
  {
    "id": "1",
    "name": "Task name",
    "description": "Optional description",
    "steps": ["Step 1", "Step 2"],
    "ticketId": "abc12345"
  },
  {
    "id": "2",
    "name": "Second task",
    "blockedBy": ["1"]
  }
]
```

## Field Reference

- `id`: Local ID for referencing in blockedBy (converted to real ID on import)
- `name`: Task name (required)
- `description`: Optional description
- `steps`: Optional array of step strings
- `blockedBy`: Reference earlier tasks by their `id` field (must reference earlier tasks)
- `ticketId`: Optional reference to a ticket's internal ID (task inherits projectPath from ticket's project)

## Validation Rules

- `id` fields are local to the import file and get converted to real IDs
- `blockedBy` references must point to tasks defined earlier in the array
- `ticketId` must reference an existing ticket in the current sprint
- Tasks with `ticketId` inherit `projectPath` from the ticket's project
