---
name: refine-grader-literals
description: refine output-format literals (## Outcome, ## Assumptions, Open question:, **Check:**) are matched verbatim by the eval grader in scripts/eval/grade.ts
metadata:
  type: project
---

The refine template's output-format headings and markers are a contract with `gradeRefine` in
`scripts/eval/grade.ts`, which another agent owns: it requires exactly `## Problem`, `## Outcome`,
`## Assumptions`, `## Scope` once each in that order, `Open question:` inside `## Outcome` for an unknown
outcome, and at least one `## Assumptions` bullet containing `**Check:**` or `Open question:`.

**Why:** the grader matches strings, so a reworded heading or marker in `refine/template.md` (or in the
`refine.contract.ts` example body the model copies) silently turns every eval trial into a fail; the
definition test only pins the template side.

**How to apply:** before renaming or rephrasing any of those literals, grep `scripts/eval/grade.ts` and
name the grader change in the report instead of editing it.
