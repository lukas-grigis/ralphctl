---
name: chain_traces_drift_fast
description: Execute / Per-task / Feedback / Onboard step traces drift most often; always verify against *-flow.test.ts before editing docs
type: feedback
---

Chain step traces in `REQUIREMENTS.md` and `ARCHITECTURE.md` are the fastest-drifting part of the docs. When new leaves are added (e.g. `render-prompt-to-file`, `resolve-branch`, `dirty-tree-preflight`, `detect-existing-files`, `confirm-start-ai`, `summarise-execution`), the docs are not always updated alongside.

**Why:** These leaves tend to land in fix/prompt/tui commits that don't announce themselves as "chain shape change" — reviewers miss the trace update.

**How to apply:** On any audit, always run `grep -n "it('runs"` against every `*-flow.test.ts` under `src/application/chains/` to extract the authoritative step order before touching the docs. The test string literal is the ground truth; the docs follow.

The four chains that changed most on the 2026-04-29→2026-05-02 branch:

- Execute outer: added `assert-tasks-not-empty`, `resolve-branch`, `dirty-tree-preflight` (before check-scripts), `summarise-execution` (after unlink-skills)
- Per-task: added `render-prompt-to-file` between `wait-for-rate-limit` and `execute-task`
- Feedback: added `load-tasks` and `render-prompt-to-file` before `apply-feedback`
- Onboard: added `detect-existing-files` and `confirm-start-ai` between `resolve-repo` and `run-onboard-ai`
