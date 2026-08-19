---
name: seams_memory_ledger_and_mutex
description: The learnings-ledger subsystem — raw-line preservation, the dedup asymmetry that is correct, the three shared-file mutexes, and the deterministic RMW-race test pattern
metadata:
  type: project
---

Files: `application/flows/_shared/memory/{learning-record,load-learnings,stamp-promoted,compact-ledger,stream-ledger}.ts`,
`flows/implement/deps.ts`, `flows/implement/wave-branch.ts`.

## Preserve untouched rows BYTE-FOR-BYTE

`learningRecordSchema` (`learning-record.ts`) is a plain `z.object` that STRIPS unknown keys on parse.
Its `.strict()` is intentionally omitted so older readers tolerate future fields — but any
read-modify-WRITE that re-serializes a parsed record silently DELETES those fields, turning "tolerate on
read" into "destroy on write". `stampPromotedLeaf` rebuilds the whole ledger on every distill, so an
older pinned `npx ralphctl@x` running distill against a shared `<memoryRoot>` would destroy fields a
newer version added.

**Rule: in any ledger rewrite, re-serialize ONLY the rows you actually mutate; every other row is
pushed from its original trimmed raw line.** Do NOT "fix" this by switching the schema to
`z.looseObject`/passthrough — that adds an index signature to the inferred type and breaks the
`_SchemaMatchesInterface` compile-time guard that fences write/read drift.

Test pattern: a ledger line carrying an extra `futureField` survives a stamp of a DIFFERENT row
unchanged — assert via raw `JSON.parse` of the on-disk line, never via `parseLearningLine`, which would
strip it back.

## The dedup asymmetry is correct — do not reconcile it

Load side and rewrite side resolve same-id duplicates differently:

- **load** (`loadLearningsLeaf`): first-occurrence-wins among unpromoted (a `seen` Set).
- **rewrite** (`stampPromotedLeaf` + `compactLedger`): an accepted id appearing twice unpromoted gets
  BOTH occurrences stamped → promoted twins → `compactLedger`'s last-promoted-wins keeps the SECOND
  row's content.

What the suppression invariant needs is that the id collapses to ONE promoted tombstone row so the
loader never re-proposes it; which twin's content survives is immaterial. Making the rewrite side match
load-side first-wins would mean special-casing "accepted duplicate" detection for zero behavioural gain.
**Test for collapse-to-one-promoted-tombstone, not for first-occurrence content.**

## Other load-bearing ledger invariants (all have tests)

- Compaction winners are carried by RAW LINE and never re-serialized (the forward-compat rule above).
- Promoted tombstones are NEVER evicted by the cap.
- `LEDGER_MAX_ROWS=500`, `LEDGER_MAX_PENDING_ROWS=200`.
- An empty accepted set still compacts when `statLedgerExceedsThreshold` (size/300 >= cap * 0.9).
- Both `stamp-promoted.ts` and `load-learnings.ts` stream via `stream-ledger.ts`'s `streamLedgerLines`
  (bounded RAM + disk).
- fs pattern in this directory: DIRECT `node:fs` for reads (no injected read port), the `WriteFile` port
  for writes — application layer, I/O allowed.

## THREE shared-file mutexes, and they do not compose

The parallel implement path has three independent `FoldQueue` instances. Picking the wrong one looks
correct and is not.

- **`ImplementDeps.journalMutex`** — `progress-journal-<taskId>`'s whole read → regenerate-header →
  append-section → write cycle on `<sprintDir>/progress.md`.
- **`ImplementDeps.ledgerMutex`** — `append-learnings-<taskId>`'s WHOLE `appendMemoryRecords` call on
  `<memoryRoot>/<projectId--slug>/learnings.ndjson`: the per-record appends AND the size-bounding
  rewrite in ONE critical section.
- **`serializeAppendFile(appendFile)`** in `wave-branch.ts` — a private queue the parallel launcher
  wraps around the `AppendFile` port; its remaining load-bearing consumer is the prologue/epilogue
  `progress.md` separator appends.

**Why the ledger mutex has to cover the whole call:** `boundLedgerIfNeeded` is a whole-file
read-modify-write (stat → read → compact → atomic rename). Guarding only the bound leaves the window
open — the append port's queue is a DIFFERENT queue, so a sibling `appendFile` can land between this
branch's read and its rename and be clobbered.

`stampPromotedLeaf` is the other whole-file ledger rewriter and is deliberately UNLOCKED, because
distill does not run concurrently with implement today. A future caller that changes that must route
through a shared mutex.

**How to apply:** when a new leaf writes a file more than one branch touches, decide append-only (the
port wrapper suffices) vs read-modify-write (needs its own `FoldQueue` on `ImplementDeps`, built once
per run in `buildImplementDepsBag` and inherited by branches via the deps spread in `wave-branch.ts`'s
`buildOneBranch`). **Every test bag that builds `ImplementDeps` must supply it** — grep
`journalMutex: createFoldQueue()` to find them.

## Testing an RMW race deterministically

Inject a `WriteFile` that PARKS its first call on a promise gate and signals when parked. Start branch
A, `await parked` (A has appended + read + compacted, rewrite pending), run branch B to completion
inside that window, then release the gate. Assert B's row is GONE without the mutex — a control test
proving the interleaving is real — and PRESENT when both calls go through one `createFoldQueue()`.
Lives in `tests/integration/application/flows/_shared/memory/ledger-writer.test.ts`.

Related: [[seams_prompt_feedforward]], [[seams_parallel_runner_architecture]].
