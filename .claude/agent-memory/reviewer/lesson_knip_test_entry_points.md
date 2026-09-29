---
name: knip-test-entry-points
description: knip stays green for exports used only by tests; grep src for a production caller
metadata:
  type: feedback
---

`knip.json` lists `tests/**/*.test.{ts,tsx}` as entry points, so an export used only by tests passes `pnpm deadcode`.
"It has tests and knip is green" does not prove a production caller exists (`applyJitter` was unwired this way).

**How to apply:** before citing a mechanism as shipped behaviour (release notes, PERFORMANCE.md, a harness review),
grep `src/` for a non-test call site.
