---
name: lesson_cut_premise_covers_one_item
description: When a removal spec's safety premise ("no default enables X") covers only one of several items being cut, prove the others dead independently — e.g. by tracing the gate that makes them unreachable
metadata:
  type: feedback
---

A cut spec often carries one safety check ("stop if a preset/default enables the setting") that only speaks for the
opt-in item. Sibling items in the same cut can be always-on, so the premise says nothing about them. Check each one
separately.

**Why:** a "remove the plateau detectors" cut paired an opt-in detector (gated by a default-off setting) with an
always-on sibling. The premise only cleared the opt-in one. The sibling turned out to be removable only because its
own gate (the same classifier the upstream evaluator uses, plus an `alreadyExiting` early return) made it
unreachable, and the implementer's grounding never showed that.

**How to apply:** for each removed runtime component, either show that its default/preset leaves it off, or trace
its gating in HEAD (`git show HEAD:<path>`) and show that an upstream step always handles the case first. If you
can't do either, the removal changes behavior and needs a fence test showing the new behavior. Related:
[[lesson_partial_wiring_of_general_seam]].
