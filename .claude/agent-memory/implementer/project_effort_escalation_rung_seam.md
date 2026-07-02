---
name: effort-escalation-rung-seam
description: Same-model effort rung in decideEscalation (default→high, between model-jump and nudge) — now ACTIVATED end-to-end (2026-07-02); records the real wiring path + the escalatedToEffort task field
metadata:
  type: project
---

**UPDATE 2026-07-02 — the rung is now ACTIVATED end-to-end.** Wiring landed via a task field
`Task.escalatedToEffort` (re-stampable optional, `z.string().optional()` in task.schema.ts, carried by
`markTaskDone`, stripped by `unblockTask`; stamped by NEW domain helper `recordTaskEffortEscalation` in
task-settle.ts). Real wiring path (launch/implement.ts is UI-fenced/off-limits, so the value threads via
the already-existing `GenEvalLoopRoleConfig.{providerId,effort}`): `per-task-subchain.ts` passes
`configuredGeneratorProvider: opts.generator.providerId as AiProvider` + `configuredGeneratorEffort:
opts.generator.effort` into `finalizeGenEvalLeaf` deps → the finalize LEAF forwards `generatorProvider` +
`generatorEffort = ctx.currentTask.escalatedToEffort ?? configured` into `finalizeGenEvalUseCase` props →
`resolveEscalatableRemedy` passes them to `decideEscalation` and, on `escalate-effort`, stamps via
`recordTaskEffortEscalation` + adds `escalate-effort` to the shouldFailAttempt set. `generator.ts` reads
`effectiveEffort = task.escalatedToEffort ?? deps.effort` at the initial spawn AND threads it into
`makeGeneratorReinvoke` (dropped its `effort` dep-pick, takes `effectiveEffort` arg). No UI edits: the
effort bump surfaces through the SAME `banner-show` event `applyEscalation` already emits (no UI file reads
the escalation fields directly). Gotcha for tests: with the default posture (opus + no effort), the effort
rung now inserts a step — the e2e "graduated ladder" test's attempt-2 became the effort bump (not the
nudge), so `escalatedFromModel` stays `sonnet` (effort rung leaves model fields untouched) and
`escalatedToEffort=max` (see 2026-07-02 provider-aware update below); budget exhausts before the nudge is
reached. See sibling [[project_criteria_history_feedforward_seam]].

**UPDATE 2026-07-02 — `nextEffortRung` is now PROVIDER- AND MODEL-AWARE (signature grew to
`nextEffortRung(provider, model, currentEffort)`).** The old fixed `target='high'` was a no-op or a
DOWNGRADE for claude-code: Claude Code's own CLI default is `xhigh` on xhigh-capable models (Opus 4.7/4.8,
Sonnet 5, Fable 5), so stamping `high` under the shipped default (opus, effort unset) replaced the implicit
`xhigh` with a weaker explicit `high`. New matrix (in `escalation-map.ts`, all logic there — effort.ts /
domain untouched, catalog fingerprint NOT touched):

- **claude-code** — model-aware `claudeEffortRung`: Haiku (`CLAUDE_EFFORTLESS_MODELS`) → skip; effective
  current = explicit effort else CLI default (`xhigh` on xhigh-capable, `high` on `CLAUDE_HIGH_DEFAULT_MODELS`
  = Sonnet 4.6); explicit `low|medium|high` on an xhigh-capable model → `xhigh`; `unset|xhigh` (and every tier
  on a non-xhigh model) → `max`; `max` → undefined (spent). Never returns ≤ effective. Ladder
  `low<medium<high<xhigh<max`; xhigh-capable is the DEFAULT for any unrecognised claude-code model (only
  Sonnet 4.6 + Haiku are exceptions).
- **github-copilot / openai-codex** — UNCHANGED: fixed target `EFFORT_ESCALATION_TARGET='high'` (that const
  is now copilot/codex-only), `unset` escalatable, `high|xhigh|max` spent, model ignored.

Once-only property: strictly ONE fire for the shipped default (opus + unset → `max` in one step) and for any
xhigh/max start; an explicit sub-xhigh claude effort (e.g. `medium`) can fire at most TWICE (medium→xhigh, then
xhigh→max via the finalize leaf's `escalatedToEffort ?? configured` re-read) — bounded because the stamped
effort climbs monotonically to the terminal `max`. NOT unbounded. Behaviour change to remember: opus + explicit
`high` now ESCALATES to `xhigh` (was a nudge) — `high` still has headroom on an xhigh-capable model. Stale
comment left behind (out of my ownership fence): `per-task-subchain.ts` ~L307 still says "default → high".

---

`decideEscalation` (src/business/task/escalation-policy.ts) gained an `escalate-effort` rung: at the
top of the MODEL ladder (no stronger `escalationMap` rung), before the same-model change-of-approach
`nudge`, it raises reasoning effort on the unchanged model. Capability lives in `nextEffortRung(...)` in
escalation-map.ts (the target computation is now provider/model-aware — see the 2026-07-02 update above;
the original fixed-`high` target + 2-arg signature described below are SUPERSEDED). This fixes the "inert
default ladder" — shipped default generator `claude-opus-4-8` sits at the model-ladder top, so previously
opus → nudge → done-with-warning; now opus → effort-bump → nudge → topped-out.

**Why:** research-grounded graduated remedy; cheapest-first (effort bump < model jump). Ordering is
effort-AFTER-model-jump (not before) so economic-preset model climbs are unchanged.

**How to apply — the rung is DORMANT until wired (mirrors escalation-map ship-then-wire precedent).**
`decideEscalation` only returns `escalate-effort` when the caller passes the OPTIONAL
`generatorProvider` + `generatorEffort` props; without them all prior behavior is byte-identical.
Three files (all OUTSIDE the escalation-policy owner's fence) must change to activate end-to-end:

1. `business/task/finalize-gen-eval.ts` `resolveEscalatableRemedy` — pass `generatorProvider` +
   `resolveEffortForRow(generator row, global)` into `decideEscalation`, AND add `escalate-effort` to
   the `shouldFailAttempt` set (currently `escalate || nudge`).
2. A re-stampable task effort field (like `escalatedToModel`) so the raised effort persists across
   the retry AND so `decideEscalation` sees it next plateau (else it re-fires until maxAttempts).
3. `application/flows/implement/leaves/generator.ts` — prefer that task field over the fixed
   `deps.effort` at spawn (mirrors `task.escalatedToModel ?? deps.model`). Without this the effort
   bump never reaches the actual spawn.

`applyEscalation`'s `escalate-effort` case stamps NO model fields (model unchanged) and emits an info
banner (no `model-escalated` event — reused generic `banner-show`, no new event type). Related:
[[project_escalation_gate_broadened]], [[project_attempt_scoped_ctx_reset_seam]].
