---
name: lesson-execute-view-plan-fixtures
description: Faking a plan for ExecuteView needs runner.element; completed groups collapse so rows hide until failed/running
metadata:
  type: feedback
---

`sessions.register` derives `planTree` from `runner.element`, so a fake runner without `element` renders the Tasks fallback, never Steps. A completed group in the Steps tree collapses to one line; to assert nested (ticket / task) rows from a static fake, put a `failed` entry in `runner.trace` (failed leaves are pinned visible).

**Why:** a "ticket rows" assertion failed twice on collapsed completed groups before this was clear.
**How to apply:** build the plan with `display.workItem` on the work-item composites; see execute-view-flow-steps.test.tsx.
