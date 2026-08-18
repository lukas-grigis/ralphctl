---
name: implement-shared-file-mutex-family
description: Three independent in-process queues guard the implement flow's shared files (journalMutex, ledgerMutex, serializeAppendFile) — which one covers what, and the gated-writeFile pattern for testing an RMW race deterministically
metadata:
  type: project
---

The parallel implement path has THREE separate `FoldQueue` instances, not one. Adding a new writer to a
file shared across branches means picking (or adding) the right one — they do not compose.

- `ImplementDeps.journalMutex` — `progress-journal-<taskId>`'s whole read → regenerate-header →
  append-section → write on `<sprintDir>/progress.md`.
- `ImplementDeps.ledgerMutex` (added for issue #288, 2026-08-18) — `append-learnings-<taskId>`'s WHOLE
  `appendMemoryRecords` call on `<memoryRoot>/<projectId--slug>/learnings.ndjson`: the per-record appends
  AND the size-bounding rewrite in ONE critical section.
- `serializeAppendFile(appendFile)` in `wave-branch.ts` — its own private queue, wrapped around the
  `AppendFile` port by the parallel launcher only. After #288 its remaining load-bearing consumer is the
  prologue/epilogue `progress.md` separator appends.

**Why:** the ledger's `boundLedgerIfNeeded` is a whole-file read-modify-write (stat → read → compact →
atomic rename). Guarding only the bound leaves the window open — the append port's queue is a DIFFERENT
queue, so a sibling `appendFile` can still land between this branch's read and its rename and be
clobbered. Wrapping the bound alone looks correct and is not.

`stampPromotedLeaf` (distill flow, `_shared/memory/stamp-promoted.ts`) is the other whole-file ledger
rewriter and is deliberately unlocked — distill does not run concurrently with implement today. A future
caller that changes that must route through a shared mutex.

**How to apply:** when a new leaf writes a file that more than one branch touches, decide append-only
(port wrapper is enough) vs read-modify-write (needs a dedicated `FoldQueue` on `ImplementDeps`, built
once per run in `buildImplementDepsBag` and inherited by branches via the deps spread in
`wave-branch.ts`'s `buildOneBranch`). Every test bag that builds `ImplementDeps` must supply it — grep
`journalMutex: createFoldQueue()` to find them (4 e2e bags + the leaf integration tests).

**Testing an RMW race deterministically:** inject a `WriteFile` that PARKS its first call on a promise
gate and signals when parked. Start branch A, `await parked` (A has appended + read + compacted, rewrite
pending), run branch B to completion in that window, then release the gate. Assert B's row is GONE
without the mutex (a control test that proves the interleaving is real) and PRESENT when both calls go
through one `createFoldQueue()`. Lives in
`tests/integration/application/flows/_shared/memory/ledger-writer.test.ts`.
