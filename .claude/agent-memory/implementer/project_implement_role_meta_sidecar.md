---
name: project-implement-role-meta-sidecar
description: stamp-role-meta leaves write rounds/<N>/<role>/role-meta.json BEFORE each spawn; the preStampedRoundNum ctx seam keeps generator round-claiming clean
metadata:
  type: project
---

In the implement flow (post-2026-05-25), `stampGeneratorRoleMetaLeaf` and `stampEvaluatorRoleMetaLeaf` run BEFORE each
spawn inside the gen-eval loop and persist per-round role attribution to
`<sprintDir>/implement/<task-id>/rounds/<N>/<role>/role-meta.json`.

**Why:** `settings.ai.implement.{generator,evaluator}.{provider,model,effort}` only lives in `settings.json`, which
mutates. Historical attribution was lost when users edited settings between runs — diagnosing the codex
`signals-missing` regression had to reconstruct provider/model from `chain.log` + git history.

**How to apply:** When wiring a new spawn-side concern that needs per-round role attribution, read `role-meta.json`
rather than re-querying settings. The shape:
`{ role, provider, model, effort: string|null, attemptN, roundN, startedAt, escalatedFromModel: string|null }`.
Forward-only — pre-existing sprint dirs do NOT get backfilled.

**Round numbering — `resolveRoundNumLeaf` → `ctx.currentRoundNum`:**

- `resolveRoundNumLeaf` runs FIRST in every gen-eval iteration (gen-eval-loop sequential), calls `nextRoundNum(workspaceRoot)`, and stamps the result onto `ctx.currentRoundNum`.
- Both stamp leaves (`stampGeneratorRoleMetaLeaf` / `stampEvaluatorRoleMetaLeaf`) and the generator/evaluator leaves then READ `ctx.currentRoundNum` — none of them call `nextRoundNum` themselves. Centralising the claim in one leaf guarantees the same N across stamp + generator + evaluator within a single turn and avoids a race between sibling disk reads.
- The stamp leaf writes `rounds/<N>/<role>/role-meta.json` (not `meta.json`) using `ctx.currentRoundNum`; it computes no round number and its output projection returns ctx unchanged.

(Prior to the refactor the generator leaf called `nextRoundNum` inside its own execute; that responsibility was extracted into `resolveRoundNumLeaf`, which is why round numbering is now a single-leaf concern.)

Related: [[project_audit09_contract.md]] (the broader audit-[09] contract for what the AI writes vs what the harness
writes — role-meta.json belongs to harness-written sidecars alongside `evaluation.md` and `commit-message.txt`).
