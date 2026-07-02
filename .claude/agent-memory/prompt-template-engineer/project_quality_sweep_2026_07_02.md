---
name: project_quality_sweep_2026_07_02
description: 2026-07-02 quality-sweep worktree — 9 verified prompt/doc defects fixed across evaluate, evaluate-continuation, implement, readiness, detect-scripts, plan, ideate templates + two _partials + HARNESS-PRINCIPLES.md; uncommitted, no placeholders added
metadata:
  type: project
---

**What happened:** a scoped defect-fix pass in worktree `.claude/worktrees/quality-sweep-2026-07-02`
(branch `ralphctl/019f1f6e-...`), touching only prompt templates the prompt-template-engineer role owns
plus `.claude/docs/HARNESS-PRINCIPLES.md`. No `.ts` files touched, no placeholders added, no git commands
run (per the calling agent's constraint) — changes are uncommitted at time of writing.

**Why:** an external audit had verified 9 concrete defects (few-shot examples modeling the forbidden
verify-script-as-primary-evidence behaviour, a self-resubstituting placeholder, a false progress-file
mechanism claim, contradictory CLAUDE.md line caps, a stale "four floor dimensions" claim, a stale "no
audit cadence" claim contradicted by a real mechanized test, a split code span, and two missing
enhancements — see [[feedback_few_shot_dominates_instructions]] and
[[feedback_dont_resubstitute_key_midsentence]] for the two most reusable lessons).

**Fixes landed (all verified against current code, not assumed):**

1. `evaluate/template.md` — 3 few-shot examples' "Phase 1: verify script exits 0" openers rewritten to
   run the criterion's own `auto` command directly (each example has `auto` criteria, so the verify-
   script fallback never legitimately applied); example 3's "Note" aside fixed to match.
2. `evaluate/template.md` — removed the mid-sentence `{{FLOOR_RUBRIC_SECTION}}` re-render; replaced with
   prose pointer.
3. `implement/template.md` — progress-file guidance corrected: harness-owned + append-only (signals
   appended at attempt settle), not "regenerated/overwritten within seconds" — the false claim would
   have under-stated the damage of a stray direct write (permanent pollution, not silently discarded).
4. `readiness/template.md` + `_partials/conventions-claude-md.md` — reconciled the 400-line generic cap
   vs the claude-md partial's 200-line cap by making the generic template defer to
   `<target_file_conventions>` for the exact ceiling; fixed the false "Claude Code truncates longer
   files" claim → "instruction adherence measurably degrades" (matches the citation already present in
   `implement/template.md`'s References section).
5. `.claude/docs/HARNESS-PRINCIPLES.md` row 15 — floor rubric is 5 dimensions (added robustness with
   `applicable: false` N/A support), single-sourced from
   `src/integration/ai/evaluation/_engine/floor-dimensions.ts` — verified against that file directly.
6. `.claude/docs/HARNESS-PRINCIPLES.md` rows 14 + 18 — both claimed "no audit cadence exists"; verified
   `tests/unit/business/task/escalation-map.test.ts` DOES mechanize the trigger (catalog fingerprint
   test, `pnpm verify` fails on a catalog change). Row 18 promoted `gap` → `partial`; both rows' "Next
   step" rewritten to name the real remaining gap — the measurement/removal ritual itself is still
   manual, only the trigger is automatic.
7. `detect-scripts/template.md` — fixed a split inline code span in the worked example.
8. `evaluate-continuation/template.md` — added its first `<examples>` block (previously zero, vs 4 in the
   full `evaluate` template) — one compact example of a criterion regressing round-over-round, caught via
   the criterion's own command, rationale-before-verdict, matching signal vocabulary.
9. `plan/template.md`, `ideate/template.md`, `_partials/validation-checklist.md` — added a nudge (with
   inline exception for pure doc/investigation tasks) toward including at least one `auto` criterion per
   task when the repo exposes a check command. Confirmed both templates load the shared
   `validation-checklist.md` partial before adding the checklist item once.

**Verification:** `pnpm typecheck` clean; `npx vitest run tests/integration/ai/prompts` (198 tests) and
`npx vitest run prompts` (32 files / 359 tests, broader substring match) both green; `prettier --check`
green on all 10 touched files. Note: `pnpm test -- prompts` run through the sandboxed shell in this
session did NOT filter (ran the full 484-file/4312-test suite) — root cause not diagnosed (likely an
arg-forwarding quirk of the sandbox's command wrapper, not a real repo issue); `npx vitest run prompts`
is the reliable equivalent. One unrelated pre-existing failure surfaced in that full run:
`tests/integration/application/ui/tui/views/home-create-hotkey.test.tsx` — not caused by this change (no
TUI/.ts files touched).

**Flagged but out of scope (not fixed — file not in the owned list):**
`.claude/docs/ARCHITECTURE.md:462` also says "four floor dimensions (Correctness / Completeness / Safety
/ ...)" — same staleness as the HARNESS-PRINCIPLES row 15 fix above, but ARCHITECTURE.md wasn't in this
task's owned-files list.
