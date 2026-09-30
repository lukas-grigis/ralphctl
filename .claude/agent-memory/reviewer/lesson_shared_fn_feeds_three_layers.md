---
name: shared-fn-feeds-three-layers
description: Enriching a shared business Result changes every presentation layer that consumes it
metadata:
  type: feedback
---

A fix to a shared business-layer function (`business/task/unblock-task.ts`) changes the behaviour of every consumer:
sprint-detail TUI, bulk TUI toast, and the CLI. A fixer whose file boundary excludes the CLI can still alter CLI output
without any CLI file appearing in the diff (a `review -> review` "reopened" line was the result).

**How to apply:** enumerate all call sites of the shared function and check each renders the new output sensibly.
Also: `max-lines` skips blanks and comments, so raw `wc -l` over 400 does not mean an ESLint failure.
