---
name: reference-restore-quarantine-doc-homes
description: Doc homes for blocked-diff quarantine / restore / parallel-epilogue facts, which must be edited together
metadata:
  type: reference
---

Facts about blocked-diff quarantine, `restore-blocked-diff` ordering and the parallel epilogue's fan-in live in several
docs that drift independently. Edit them together, starting from the deepest:

1. `WORKFLOWS.md` § "Blocked-diff quarantine & restore" (the dense prose; it rots first because nobody rereads it).
2. `ARCHITECTURE.md` § "Parallel task execution" (inside `## Chain framework`).
3. `REQUIREMENTS.md` `## Implement flow`: the attempt-body checkbox and "Blocked-task recovery is never silent".
4. Lighter homes: `PERFORMANCE.md` parallel-scheduler paragraph, `SECURITY.md` skills-install text, and
   `DESIGN-SYSTEM.md` "Reconciling a live trace against the polled entity".

**Read the actual conditional.** For a paragraph describing an asymmetric guard (one arm gated, the other not), or a
resume gate paraphrased as "latest success", quote the code's shape (`findLast(... outcome !== 'skipped')`) rather than
inferring symmetry from surrounding prose. A doc claim can be wrong the moment it is written, not just stale.
