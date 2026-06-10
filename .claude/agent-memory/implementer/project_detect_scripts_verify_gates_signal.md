---
name: detect-scripts-verify-gates-signal
description: T9 verify-gates signal — single signal carrying a gates array (not per-gate), additive to verify-script, write path needed RepositoryUpdate extension
metadata:
  type: project
---

T9 of PLAN-gen-eval-speed.md (feat/gen-eval-speed) taught the detect-scripts flow to propose
structured per-module `verify-gates` alongside the legacy single-line `verify-script`.

**Signal name resolution (deviation from plan wording).** PLAN T9 says signal `verify-gate`
(singular, per-gate); the T9 task brief says `verify-gates` carrying an ARRAY. Chose the brief:
ONE `VerifyGatesSignal { type:'verify-gates', gates: VerifyGateProposal[] }` modelled on
`SkillSuggestionsSignal` (one signal, `names[]`). Avoids the "at most one of each kind" coordination
problem per-gate signals would create.

**Why:** field-name drift between template and Zod schema silently drops the whole signal (see
[[refine_signal_field_drift]] in the auto-memory). The schema, the template's `<output_contract>`,
and the worked JSON example all name the exact keys: `gates[].pathPrefix`, `gates[].command`,
`gates[].timeoutMs?` — pinned by a definition-test assertion.

**How to apply (gotchas for downstream T-work on this branch):**

- `verifyGatesSignalSchema` uses `.nonempty()` — an empty `gates: []` is REJECTED. Single-module
  repos OMIT the signal entirely; an empty array can never masquerade as "no modules".
- Write path: T8 added `setRepositoryVerifyGates` to the entity but did NOT wire `verifyGates` into
  `RepositoryUpdate` / `updateRepository` (project.ts). T9 added both — the detect-scripts write
  leaf persists via `updateRepository`, so that wiring was a prerequisite.
- Gates are NOT inline-editable in the confirm leaf (a single-line text prompt can't tweak a
  structured map). They ride through approve/edit verbatim and count toward `accepted`; only the
  legacy `verifyScript` fallback is line-editable.
- Adding a member to the `HarnessSignal` union forces a case in the `rowForSignal` switch in
  `tasks-panel-internals/signal-rows.tsx` (exhaustive, no `default`) — reused the `'script'` label.
- House rule held: no hardcoded package managers in the gate-guidance PROSE; the worked JSON example
  uses the `<tool>` placeholder convention the other examples already use. The package-manager
  negative-match test must anchor on the bold CONSTRAINT heading `**Per-module verify gates`, NOT
  the same phrase in the success-criteria summary (which slices through the JVM `mvn` constraint).
