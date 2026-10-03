---
name: project-pipeline-and-next-steps
description: One pipeline widget, one next-step table; the invariant that ties the pipeline stage to the first flow row
metadata:
  type: project
---

`SprintPipeline` is the only stage widget and `buildNextSteps` the only next-step table; sprint-detail has no table of its own. The first flow row of `buildNextSteps` must name the same phase the pipeline highlights (a unit test sweeps every status x pending/not).

**Why:** screens used to say "you're on Refine" while advising Plan because pipeline-map, sprint-pipeline and the detail header each kept their own mapping.

**How to apply:** change stage resolution and the next-step rows together. Flow rows carry `flow` (no key — launched by the focused row / footer); only non-flow rows carry a real key. A draft sprint with zero tickets is at Refine. Sprint name/status no longer render in the sprint-detail body (LocationBar owns them), so tests must not use the sprint name as a readiness signal — wait on `Tickets` or `next:`.
