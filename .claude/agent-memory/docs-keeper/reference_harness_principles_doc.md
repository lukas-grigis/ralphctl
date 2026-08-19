---
name: reference-harness-principles-doc
description: HARNESS-PRINCIPLES.md is the canonical home for harness research principles — 18 rows, each with a status tag that must be re-evaluated when chain/flow/_engine changes
metadata:
  type: reference
---

`.claude/docs/HARNESS-PRINCIPLES.md` holds 18 principles, each with **Rule** / **Source** /
**ralphctl status** (`applied` / `partial` / `gap`) / **Where it lives**. As of 2026-08-19: 16
`applied`, 2 `partial` (minimal scaffolding, context reset), 0 `gap`. Re-count rather than trust that
line — the distribution moves every time a row's status is promoted.

**How to apply:** when a structural change lands in `src/application/chain/`,
`src/application/flows/`, or `src/integration/ai/providers/_engine/`, check whether it changed a row's
status. Update the status tag, the "Where it lives" anchor, and delete the "Next step" line when a gap
closes. A change can also _weaken_ an `applied` row — demotion is as valid an edit as promotion.

Related: [[reference_agent_files_also_drift]] — the agent files reference this doc too.
