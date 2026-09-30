---
name: project_outcome_report_card
description: Outcome-card empty-state predicate counts declared criteria; empty fixtures need tasks: []
metadata:
  type: project
---

`hasAttemptData(rollup)` in `sprint-detail-internals/outcome-card.tsx` counts `criteria.declared`, which is populated
from a task's declared `verificationCriteria` even when no verdict was ever recorded. A fresh `todo` task with criteria
authored therefore counts as "has data". Test fixtures for the true empty state must use `tasks: []`, not one
unattempted task.
