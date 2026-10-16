---
name: project-note-guidance-coupling
description: Shared-partial guidance that tells a role to emit a `note` collides with the apply-feedback and create-pr contracts, which accept no notes
metadata:
  type: project
---

`autonomous-operation.md` tells roles to record extras and skill conflicts in a `note` signal. The apply-feedback contract accepts only `task-complete` or `task-blocked`, and create-pr keeps only `pr-content`.

**Why:** new note-emitting lines in a shared partial silently contradict those two flows. apply-feedback's template carries an override sentence ("any other signal kind … whatever the autonomous-operation guidance above says about notes"), pinned by its definition test. `one-shot-operation.md` says nothing about notes for the same reason.

**How to apply:** before adding signal-kind guidance to a shared partial, read each consuming flow's `*.contract.ts`. Open point for the contract owner: the apply-feedback sentence says other signals "fail validation of the whole file", but the review-round contract filters non-terminal entries out before validating, so the claim overstates.
