---
name: second-implementation-of-shared-rule
description: A hand-copied clamp/floor drifts silently; a docblock saying it matches is not a fence
metadata:
  type: feedback
---

A private copy of a shared rule (the readiness flow once inlined the codex effort floor instead of calling
`clampEffortToProvider` in `src/business/settings/resolve-effort.ts`) drifts the moment the shared rule changes, while
typecheck, lint and the full suite stay green. A comment claiming "matches the table" mechanizes nothing.

**How to apply:** on any diff touching provider effort vocabulary, the clamp, or `PROVIDER_EFFORT_LEVELS`, grep all of
`src/` (not just `src/business/`) for effort-floor literals such as `provider === 'openai-codex' && effort`. A second
implementation outside `resolve-effort.ts` is the failure. `tests/integration/application/flows/readiness/effort-resolution.test.ts`
pins the readiness consumer to the shared clamp.
