---
name: project_execute_rail_fix
description: Execute view rail-width fix + step-ID label separation design decisions (May 2026)
metadata:
  type: project
---

Decided to widen the rail responsively AND truncate labels at rail boundary (Option D hybrid).
`resolveRailWidth(columns)` exported from tokens.ts — pure function, called once in execute-view.

**Why:** Fixed 24-char RAIL_WIDTH is the root cause of wrapping at ≥180 cols. The wasted right-hand
space at ~200 cols is explained by the Context column being `flexShrink={0}` with no balancing
`flexGrow` — Yoga packs all three columns left and the unallocated width sits to the right (not a
ViewShell or Layout bug).

**Step-ID label separation:** Add optional `label?: string` to `Element` interface and `TraceEntry`.
The `leaf` factory accepts `label` in a new optional third param `opts?: { label?: string }`.
`StepTrace` renders `row.label ?? row.name`. Flow definitions that currently embed paths in IDs
(only `implement/flow.ts` — the `preflight-task-N-<abs-path>` pattern) add a `label` instead.

**How to apply:** When touching chain element creation or execute-view layout, remember these
decisions are locked in. Don't revert to a fixed rail or path-embedded IDs.

Pattern for short repo name: `basename(cwd)` — already a string at call site in flow.ts.
