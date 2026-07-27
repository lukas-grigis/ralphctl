---
name: parallel-implement-wave-ordering-lock
description: scheduleIntoWaves dependency-fence tests + concurrent FsTaskRepository saveAll/update integrity — parallel-ordering-and-lock.test.ts
metadata:
  type: feedback
---

`tests/integration/application/flows/implement/parallel-ordering-and-lock.test.ts` — 7 tests:

- `scheduleIntoWaves` puts an `in_progress` prerequisite in wave 0 and its dependent `todo` in wave 1
- Dependent wave index is strictly greater than its prerequisite for a multi-hop chain (a→b→c)
- Parallel element executes all wave-0 branches before any wave-1 branch starts (log-order fence)
- Non-fatal wave-0 failure absorbed; wave-1 still runs after wave-0 settles
- concurrent `saveAll` (epilogue) + `update` (branch settle) on real `FsTaskRepository` never tears
  tasks.json
- High-concurrency (16 ops) interleaved `saveAll`+`update` always lands a consistent 4-task set
- Sprint-scoped lock is held when the epilogue runs (`epilogueCalledWhileLockHeld === true`)

**Key pattern**: `scheduleIntoWaves` is status-agnostic — it uses `task.order` + `dependsOn` only.
In_progress-first ordering from `resolveImplementQueue` is already baked into the queue before
`scheduleIntoWaves` sees it; the wave scheduler enforces the dependency fence.
