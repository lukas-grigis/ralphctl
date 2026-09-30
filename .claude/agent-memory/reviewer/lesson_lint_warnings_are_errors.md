---
name: lesson-lint-warnings-are-errors
description: `pnpm lint` runs with --max-warnings 0, so an implementer's "just a max-lines warning" breaks the gate
metadata:
  type: feedback
---

`pnpm lint` is `eslint . --max-warnings 0`. `max-lines` (400, skipBlank/skipComments) and
`max-lines-per-function` (80) are configured as `warn`, and they still fail the gate.

**Why:** in the 2026-09-29 prompt-audit lane, the implementer reported best-of-n-selection.ts at 431 lines
as "one warning, accept or split?". It was a gate failure that would have blocked `/verify`.

**How to apply:** when a report mentions any ESLint warning on a touched file, treat it as Must-Fix.
Confirm it's new with `git show HEAD:<file> | npx eslint --stdin --stdin-filename <file>`.
