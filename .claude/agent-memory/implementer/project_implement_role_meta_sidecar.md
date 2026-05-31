---
name: project-implement-role-meta-sidecar
description: stamp-role-meta leaves write rounds/<N>/<role>/meta.json BEFORE each spawn; the preStampedRoundNum ctx seam keeps generator round-claiming clean
metadata:
  type: project
---

In the implement flow (post-2026-05-25), `stampGeneratorRoleMetaLeaf` and `stampEvaluatorRoleMetaLeaf` run BEFORE each
spawn inside the gen-eval loop and persist per-round role attribution to
`<sprintDir>/implement/<task-id>/rounds/<N>/<role>/meta.json`.

**Why:** `settings.ai.implement.{generator,evaluator}.{provider,model,effort}` only lives in `settings.json`, which
mutates. Historical attribution was lost when users edited settings between runs — diagnosing the codex
`signals-missing` regression had to reconstruct provider/model from `chain.log` + git history.

**How to apply:** When wiring a new spawn-side concern that needs per-round role attribution, read `meta.json` rather
than re-querying settings. The shape:
`{ role, provider, model, effort: string|null, attemptN, roundN, startedAt, escalatedFromModel: string|null }`.
Forward-only — pre-existing sprint dirs do NOT get backfilled.

**Non-obvious architectural seam — `ctx.preStampedRoundNum`:**

- The stamp leaf computes round N via `nextRoundNum(workspaceRoot)`, writes `rounds/N/generator/meta.json`, then seeds
  `ctx.preStampedRoundNum = N`.
- Without this seam, the downstream `generatorLeaf` would call `nextRoundNum` itself, find `rounds/N/generator/` already
  populated by the stamp, and return N+1 (wrong).
- The generator leaf prefers `ctx.preStampedRoundNum` over its own `nextRoundNum` call, then CLEARS the field in its
  output projection so a subsequent loop iteration without the stamp leaf (legacy callers) still falls back cleanly.
- This is separate from `ctx.currentRoundNum`, which persists generator → evaluator within a single turn. Don't conflate
  them — `currentRoundNum` is the cross-leaf hand-off within a turn, `preStampedRoundNum` is the single-leaf-jump from
  stamp to generator.

Related: [[project_audit09_contract.md]] (the broader audit-[09] contract for what the AI writes vs what the harness
writes — meta.json belongs to harness-written sidecars alongside `evaluation.md` and `commit-message.txt`).
