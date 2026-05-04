<signals>

- `<task-verified>output</task-verified>` — Records verification results (required before completion)

Emit `<task-verified>` before `<task-complete>` — omitting verification leaves the harness with no record of what passed.

- `<task-complete>` — Marks task as done (ONLY after verified)
- `<task-blocked>reason</task-blocked>` — Marks task as blocked (cannot proceed)

</signals>
