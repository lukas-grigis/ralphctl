---
name: ledger-compaction-dedup-asymmetry
description: stamp-promoted compaction collapses accepted-duplicate ids via last-promoted-wins, NOT load-side first-wins — both are correct
metadata:
  type: project
---

The learnings ledger has a bounded RAM+disk cap (`fix/oom-hardening`): `stamp-promoted.ts` streams via
`stream-ledger.ts`'s `streamLedgerLines`, runs an inline stamp pass, then `compact-ledger.ts`'s
`compactLedger`, then atomic `WriteFile`. `load-learnings.ts` also streams (pure RAM win).

Subtle dedup asymmetry — load side vs rewrite side resolve same-id duplicates differently, and BOTH are correct:

- **load side** (`loadLearningsLeaf`): first-occurrence-wins among unpromoted (seen Set).
- **rewrite side** (`stampPromotedLeaf` + `compactLedger`): if an accepted id appears twice unpromoted, the
  stamp pass stamps BOTH occurrences → both become promoted twins → `compactLedger`'s last-promoted-wins keeps
  the SECOND row's content.

**Why:** what matters for the suppression invariant is that the id collapses to ONE promoted (tombstone) row so
the loader never re-proposes it — the _content_ of the surviving row (first vs second twin) is immaterial.

**How to apply:** don't "fix" the rewrite side to match load-side first-wins; it would mean special-casing
"accepted duplicate" detection for no behavioral gain. When writing tests for this path, assert
collapse-to-one-promoted-tombstone, not first-occurrence content.

Other load-bearing invariants in this code (all have tests): compaction winners carried by RAW LINE never
re-serialized (forward-compat for unknown future fields — see [[project_ledger_unknown_field_preservation]]);
promoted tombstones NEVER evicted by the cap; `LEDGER_MAX_ROWS=500` / `LEDGER_MAX_PENDING_ROWS=200`; empty
accepted set still compacts when `statLedgerExceedsThreshold` (size/300 >= cap\*0.9). fs pattern: this dir uses
DIRECT node:fs for reads (no injected read port), `WriteFile` port for writes — application layer, I/O allowed.
