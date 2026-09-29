---
name: binding-decision-over-design-table
description: When a design and a later binding decision disagree, verify against the decision and cross-check the design's risks
metadata:
  type: feedback
---

When a change ships with a design doc plus a later binding user decision that supersedes part of it, review against
the binding text, not the design's original table. Read the design's own `risks` section: a risk the binding text
does not address is a real Must-Fix, not a nitpick (the design's outcome-based "kept" mapping for worktree setup dirt
was self-defeating, and a real-git test proved a fold could never succeed there).

**How to apply:** reproduce the predicted failure with real git rather than reasoning about it.
