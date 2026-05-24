---
name: reference_harness_principles_doc
description: HARNESS-PRINCIPLES.md is the canonical home for harness research principles; 18 rows with applied/partial/gap status; must be updated when chain/flow/_engine changes close a gap or weaken an applied row.
metadata:
  type: reference
---

`.claude/docs/HARNESS-PRINCIPLES.md` — landed in the `worktree-agent-ad1b25382f7b772d4` commits (695b488e..fbda7474).

18 principles, each with **Rule** / **Source** / **ralphctl status** / **Where it lives**. Current status distribution:

- `applied`: 13 principles (1–13)
- `partial`: 2 principles (14 — minimal scaffolding, 16 — context reset)
- `gap`: 3 principles (15 — evaluator tuning, 17 — cost-benefit framing, 18 — model-bump audit cadence)

**How to apply:** When any structural change lands in `src/application/chain/`, `src/application/flows/`, or `src/integration/ai/providers/_engine/`, audit step 10 in the docs-keeper audit workflow checks whether a row's status changed. Update the status tag, "Where it lives" anchor, and remove "Next step" when a gap closes.

Related: [[reference_agent_files_also_drift]] — agents also reference the principles doc now via their hooks.
