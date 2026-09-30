---
name: lesson-catalog-bump-fallout
description: Model-catalog and ladder bumps break tests far from the catalog files; recompute fingerprints by running the gate
metadata:
  type: feedback
---

`decideEscalation` checks the model-mapping rung BEFORE the effort rung, nudge and topped-out branches. A test that
hardcodes the "top of ladder" model to exercise `nudge`, `topped-out` or `escalate-effort` silently starts exercising
`escalate` when that model gains a rung; the diff names the OLD top (`expected 'escalate' to be 'nudge'`). Such
fixtures live in `escalation-policy*.test.ts`, `finalize-gen-eval.test.ts` and e2e implement fixtures, none named after
the catalog.

**How to apply:** after a ladder or effort-clamp change, run the FULL `tests/unit`, `tests/integration` and
`tests/e2e` suites and read every diff; a change spec's file list is a floor. Grep `tests/` for the exported function
(`clampEffortToProvider`), not only for literal ids: `resolve-agent-override.test.ts` re-derives through it.

**Fingerprint gate:** `tests/unit/business/task/escalation-map.test.ts` pins a sha256 fingerprint per provider catalog
(currently more than three; see the test) and is designed to fail on any catalog change. Never hand-compute: the
failure shows only the FIRST mismatch (a sync `expect` throws), so to get every hash write a scratchpad `npx tsx`
script that imports the `*_MODELS` arrays by absolute path and copies the test's fingerprint function exactly.
