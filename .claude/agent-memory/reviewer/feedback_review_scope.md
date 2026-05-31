---
name: feedback_review_scope
description: Review approach — full branch diff, all four tool checks, per-file deep read of new code
metadata:
  type: feedback
---

When reviewing a feature branch, always: (1) `git diff main...HEAD --name-only` to enumerate all changed files; (2) read each new file in full rather than skimming; (3) run pnpm typecheck / lint / test (targeted) / deadcode; (4) verify layer rules manually for new integration paths (not just ESLint flags).

**Why:** ESLint catches most layer violations but misses cross-\_shared imports that aren't in the FLOWS sibling list.

**How to apply:** For every new file under `application/flows/_shared/`, manually scan its imports for references to sibling named flows (e.g. `readiness/flow.ts`). The ESLint rule only blocks imports FROM named FLOWS, not FROM `_shared`.
