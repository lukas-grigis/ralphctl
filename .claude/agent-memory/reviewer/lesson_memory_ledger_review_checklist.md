---
name: memory-ledger-review-checklist
description: What to check when reviewing learnings-ledger / distill changes
metadata:
  type: feedback
---

Checklist for diffs touching the learnings ledger or the distill sub-chain:

1. Dedup id stability across runs.
2. Stamp-after-write ordering (`stamp-promoted` only once the write succeeded).
3. AbortError propagates through the nested runner and leaves the ledger un-stamped; non-abort distill failures stay
   best-effort so the sprint still closes.
4. The empty-candidates bypass for the propose step.
