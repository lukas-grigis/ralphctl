---
name: chain_traces_drift_fast
description: Flow step traces drift fast; always verify against the flow's e2e test before editing docs
type: feedback
---

Flow / chain step traces in `REQUIREMENTS.md` and `ARCHITECTURE.md` are the fastest-drifting part of the docs. When new
leaves are added (e.g. a `render-prompt-to-file`, `resolve-branch`, `dirty-tree-preflight`, `summarise-execution`), the
docs are not always updated alongside.

**Why:** These leaves tend to land in fix/prompt/tui commits that don't announce themselves as "chain shape change" —
reviewers miss the trace update.

**How to apply:** On any audit, extract the authoritative step order from the flow's e2e test under
`tests/e2e/flows/<flow>.test.ts` (one file per flow: `implement`, `plan`, `refine`, `ideate`, `review`, `create-pr`,
`readiness`, `detect-scripts`, `detect-skills`, `close-sprint`, …) before touching the docs. Grep the `describe(...)` /
`it(...)` titles and the asserted trace there — the test is the ground truth; the docs follow.
