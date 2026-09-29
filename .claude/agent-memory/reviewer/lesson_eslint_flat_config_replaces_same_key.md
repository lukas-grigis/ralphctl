---
name: eslint-flat-config-replaces-same-key
description: Overlapping flat-config blocks replace same-key rule options; verify a fence by probe
metadata:
  type: feedback
---

ESLint flat config REPLACES a same-key rule entry when a later block matches the same file; options never merge. A
block narrowing a broader glob silently wipes the broader block's `no-restricted-imports` entries. Nine fences were
dead this way before `mergeRestrictedImports` in `eslint.config.ts` made each block carry the union.

**How to apply:** when a new `no-restricted-imports` block lands, extend the liveness suite in
`tests/unit/eslint-config.test.ts` (it probes each overlap with `Linter().verify`). Verify a "fence exists" claim by
probing it, not by reading the config.
