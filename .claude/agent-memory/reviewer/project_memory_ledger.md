---
name: project_memory_ledger
description: Theme 6 procedural memory — append-only learnings ledger, distill sub-chain, per-task attempt outer loop, task-graph validation. Landed in feat/wiring-memory.
metadata:
  type: project
---

Theme 6 memory is live: per-attempt `<learning>` signals append to `<dataRoot>/memory/<projectId>/learnings.ndjson` via `appendLearningsLeaf` (before `progress-journal`). At sprint close/review, an opt-in human-gated `distill` step (defaults No) runs a self-contained `createDistillLearningsSubChain` — `load → propose → confirm → write` per distinct provider, then `stamp-promoted` — as a nested runner inside `createDistillStep`. Non-abort distill failures are best-effort (sprint still closes). AbortError propagates and leaves the ledger un-stamped.

The per-task attempt outer loop (`loop('task-attempts-<id>')` in `per-task-subchain.ts`) bounds by `task.maxAttempts` (1–10). `start-attempt` now resets gen-eval ctx fields between attempts.

Task-graph validation (`validateTaskGraph` / `scheduleIntoWaves`) lives in `src/domain/entity/task-graph.ts`; called at both `parseTaskList` and `resolveImplementQueue`.

**Why:** Durable learnings let the AI carry repo-specific insights across sprints; the outer attempt loop + escalation-on-plateau work without requiring a re-launch.

**How to apply:** When reviewing memory/distill changes, check: (1) dedup id stability, (2) stamp-after-write ordering, (3) AbortError propagation through the nested runner, (4) empty-candidates bypass for the propose step.
