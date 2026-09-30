---
name: execute-view-terminal-state
description: Views read descriptor.status live; never add a view-level runner subscription
metadata:
  type: project
---

`SessionManager.attachRunnerLifecycle` writes the terminal `status` and `finishedAt` into the descriptor itself, so
views read `descriptor.status` directly. Do not add a local `runnerStatus` state or a view-level `runner.subscribe()`.

**Why:** the descriptor is already live; a second subscription can only drift from it.
