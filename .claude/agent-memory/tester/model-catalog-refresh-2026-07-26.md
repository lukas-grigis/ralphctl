---
name: model-catalog-refresh-2026-07-26
description: Pattern for updating tests after a model-catalog/escalation-ladder refresh (Opus 5 / GPT-5.6 bump) — ladder-rung changes cascade into "top of ladder" test fixtures far beyond the catalog/preset files themselves
metadata:
  type: feedback
---

When a provider model-catalog refresh changes `DEFAULT_ESCALATION_MAP` rungs — especially when a
model that was previously the TOP of a ladder (no outgoing key) gains a new rung — grep is not
enough to find every affected test. `decideEscalation` checks the model-mapping rung BEFORE the
same-model effort rung / nudge / topped-out branches, so any test that hardcodes a "top of ladder"
model (to exercise `nudge`, `topped-out`, or `escalate-effort`) breaks silently if that model later
gains a rung — the test starts exercising `escalate` instead, with a confusing "expected X to be Y"
diff that names the OLD top-of-ladder value, not the new one.

**Where this bit in the 2026-07-26 refresh** (`claude-opus-4-8` gained a rung to the new
`claude-opus-5` flagship): `tests/unit/business/task/escalation-policy.test.ts`,
`escalation-policy-branches.test.ts`, `finalize-gen-eval.test.ts`, and one e2e fixture in
`tests/e2e/flows/implement.test.ts` all had tests pinned to `claude-opus-4-8` as "the top" — every
one had to move to the new actual top (`claude-opus-5`) to keep testing the same branch. None of
these files are named "escalation-map" or "presets", so they are easy to miss if you only chase the
catalog/preset files named in a change spec.

**How to find them:** after updating `DEFAULT_ESCALATION_MAP`, run the FULL `tests/unit` +
`tests/integration` + `tests/e2e` suite (not just the files a spec names) and read every failure's
diff — a diff shape like `expected 'escalate' to be 'nudge'` or `expected '<new-model>' to be
'<old-model>'` is the signature of a stale top-of-ladder fixture. Don't assume the change spec's
enumerated test-file list is exhaustive; treat it as a floor, not a ceiling. See
[[fingerprint-audit-gate-pattern]] for the parallel gate on the catalog side.

Also: `resolveEffort`/`clampEffortToProvider` behavioral changes (e.g. codex floor moving from
`xhigh/max → high` to `max → xhigh`) ripple into `resolve-agent-override.test.ts` even though that
file's name gives no hint it touches provider effort clamping — it re-derives through the same
`clampEffortToProvider` seam. Grep for the exported function name across `tests/`, not just for
literal model/effort strings, to find every consumer.
