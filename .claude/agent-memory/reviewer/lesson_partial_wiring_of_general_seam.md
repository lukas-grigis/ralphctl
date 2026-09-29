---
name: partial-wiring-of-general-seam
description: A seam documented as general but wired into one launcher leaves sibling flows broken
metadata:
  type: feedback
---

When a memory or doc states a seam as general (e.g. "presence of `AppDeps.providerSpawn` skips the `checkCli` PATH
pre-flight"), grep every launcher under `src/application/ui/shared/launch/` for the wiring. It was wired into
`implement.ts` only, so a no-CLI user following the demo sandbox into plan/refine hit a surprising failure.

**How to apply:** flag it either way: extend the wiring, or narrow what the UI copy implies.
