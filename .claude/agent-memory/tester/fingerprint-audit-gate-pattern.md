---
name: fingerprint-audit-gate-pattern
description: How to recompute the deliberately-failing SHA-256 catalog fingerprint test in escalation-map.test.ts after a model-catalog bump — never hand-compute, run the test and read the actual hash from the failure output
metadata:
  type: feedback
---

`tests/unit/business/task/escalation-map.test.ts` fingerprints `CLAUDE_MODELS` / `CODEX_MODELS` /
`COPILOT_MODELS` (sorted, joined, sha256, first 16 hex chars) and pins the three hashes as a
deliberate verify-gate: the test is DESIGNED to fail the moment any catalog changes, forcing a
human/agent to walk the HARNESS-PRINCIPLES.md model-bump checklist before silencing it.

**Procedure that works:** don't hand-compute the hash or guess. After all catalog edits land, run
`npx vitest run tests/unit/business/task/escalation-map.test.ts` — the failure output prints
`Expected: "<old>" / Received: "<new>"` for the FIRST mismatching assertion only (synchronous
`expect` throws stop the test, so only one of the three shows). To get all three at once, write a
one-off script importing the three `*_MODELS` arrays with ABSOLUTE paths (not relative — a script
run from a scratchpad dir needs `/full/path/to/src/...`) and run it with `npx tsx`, replicating the
test's exact fingerprint function (sort, join with `\n`, sha256, slice(0,16)). Paste the three
printed hashes directly into the test's `toBe(...)` calls — do not modify the fingerprint function
itself.

This is the same pattern as any "pin a hash / snapshot as an audit trigger" test — the fix is
always "run it, read the diff, paste the actual value," never "compute it by hand."
