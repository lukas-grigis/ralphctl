---
name: duplicate-codex-effort-clamp
description: RESOLVED 2026-07-26 — the readiness flow's hand-copied codex effort floor is gone; effort clamping now has exactly one implementation, pinned by an integration test
metadata:
  type: project
---

`src/application/flows/readiness/flow.ts` used to define its own private `resolveEffortForRow(ai, flow)`
with an inline copy of the codex effort floor (`if (row.provider === 'openai-codex' && …) return 'high'`)
instead of calling the exported `clampEffortToProvider` from `src/business/settings/resolve-effort.ts`.
Its docblock claimed the floor table matched — nothing mechanized the claim, so the two drifted.

**Why it mattered:** it bit the 2026-07-26 provider model-catalog refresh. That change relaxed the codex
clamp from `xhigh|max → high` to `max → xhigh`, updated every other consumer, and left the readiness copy
untouched — `mixed-frontier` (global `max`, codex row) resolved to `xhigh` everywhere except readiness.
Typecheck, lint and the full suite were green throughout.

**Current state (fixed in the same 2026-07-26 pass):** the duplicate is deleted; readiness calls
`clampEffortToProvider` directly (application → business is a legal direction), and
`tests/integration/application/flows/readiness/effort-resolution.test.ts` runs the readiness chain with a
global codex `max` and asserts the recorded session effort equals `clampEffortToProvider('max',
'openai-codex')`. A grep of `src/` shows exactly one `provider === 'openai-codex' && effort === …` clamp.

**How to apply:** on any diff touching provider effort vocabulary, the clamp, or `PROVIDER_EFFORT_LEVELS`,
re-run the grep for effort-floor literals across `src/` (not just `src/business/`) — a second
implementation reappearing outside `resolve-effort.ts` is the failure mode, and only the readiness test
currently pins a consumer to the shared clamp.

Related: [[project_model_refresh_review_2026-07-26]]
