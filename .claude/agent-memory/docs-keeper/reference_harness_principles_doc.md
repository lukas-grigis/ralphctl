---
name: reference-harness-principles-doc
description: HARNESS-PRINCIPLES.md is the canonical home for harness research principles — each row has a status tag that must be re-evaluated when chain/flow/_engine changes
metadata:
  type: reference
---

`.claude/docs/HARNESS-PRINCIPLES.md` holds status-tagged principles, each with **Rule** / **Source** /
**ralphctl status** (`applied` / `partial` / `gap`) / **Where it lives**. Read the current tags; they move whenever
a row is promoted or demoted.

**How to apply:** when a structural change lands in `src/application/chain/`,
`src/application/flows/`, or `src/integration/ai/providers/_engine/`, check whether it changed a row's
status. Update the status tag, the "Where it lives" anchor, and delete the "Next step" line when a gap
closes. A change can also _weaken_ an `applied` row — demotion is as valid an edit as promotion.

Related: [[reference_agent_files_also_drift]] — the agent files reference this doc too.
