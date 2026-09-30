---
name: seams_model_catalog_refresh
description: Checklist for refreshing a provider model catalog — the sha256 fingerprint gate, where the retired-model remap is actually tested, the prose restatement, and the lint hazard in settings.ts
metadata:
  type: project
---

A catalog refresh (`domain/value/settings-models/{claude,codex,copilot}.ts`) touches places that are
NOT reachable by grepping for the changed slugs.

## Three hidden touchpoints

1. **`tests/unit/business/task/escalation-map.test.ts` — the catalog fingerprint gate.** It asserts a
   16-hex-char truncated sha256 over each catalog's sorted ids joined by `\n`. ANY catalog edit fails
   it by design: it mechanizes the model-bump audit trigger. Recompute by RUNNING the test and pasting
   the actual hash, or independently, e.g.

   ```
   npx tsx -e "import {createHash} from 'node:crypto'; import {COPILOT_MODELS} from './src/domain/value/settings-models/copilot.ts'; console.log(createHash('sha256').update([...COPILOT_MODELS].sort().join('\n')).digest('hex').slice(0,16))"
   ```

   The same file also holds lockstep tests asserting every `DEFAULT_ESCALATION_MAP` key AND value is a
   member of some catalog, so renaming or delisting a slug used in a ladder rung fails there too.

2. **`RETIRED_MODEL_REMAPS` coverage lives in `tests/unit/business/settings/implement-shape.test.ts`**,
   NOT in `json-settings-repository.test.ts` — the repository test only covers the file-level load
   path. Extend both: implement-shape for the schema-level remap + provider-guard proof, and
   json-settings-repository for a real persisted-file → `load()` round trip that also asserts the
   on-disk file is left untouched (**the remap is read-time only; nothing is rewritten until the next
   `save()`**).

3. **`.claude/docs/AI-SETTINGS.md`** restates each catalog in prose, including a model COUNT and an
   "Added since the last reconciliation" / "Removed" paragraph. Nothing guards it — it goes stale
   silently.

## Retired ids outside settings rows

`RETIRED_MODEL_REMAPS` is not only a settings-row concern. Two other persisted places carry model ids:
`task.escalatedToModel` (resolved through `effectiveGeneratorModel` in `escalation-policy.ts`, the ONE
site for spawn / policy lookup / meta.json) and `harness.escalationMap` values (rewritten at parse only
when `unambiguousRetiredSuccessor` says so; ambiguous ones warn in `wire.ts`). Slugs retired on one
provider can be LIVE on another (`gpt-5.4`, `gpt-5.3-codex` are still Copilot ids), so a provider-less
remap must check every catalog.

`generator.ts` sits at the `max-lines` 400 ceiling (comments/blank skipped) — a new import or field
there trips lint; merge imports or put the field on `RoleLeafDeps`.

## Sweep order

catalog file → `RETIRED_MODEL_REMAPS` in `src/domain/entity/settings.ts` → fingerprint → the two remap
test files → AI-SETTINGS.md → HARNESS-PRINCIPLES.md model-bump audit-log entry (the fingerprint test's
comment demands the audit; every bump so far left a dated entry) → CHANGELOG (maintainer's call).

## CLI default effort is not the API default effort

`CLAUDE_CLI_DEFAULT_EFFORT` must come from code.claude.com/docs/en/model-config, NOT the platform
models-overview / effort pages. They disagree: Sonnet 5.5 is `medium` in Claude Code but documented as
`high` on the Claude API. The rung tracks what the spawned CLI runs. A wrong entry makes the effort rung
re-stamp the implicit default (a no-op attempt) or skip a tier.

## Moving a preset constant (e.g. `SONNET`) trips tests no grep for the catalog finds

The eval harness default arm is `applyPreset('claude-economic')`, so `tests/unit/scripts/eval/arms.test.ts`
and `tests/integration/scripts/eval/{run-evaluate,run-flows,real-adapter}.test.ts` hardcode the preset's
Sonnet id. The TUI `settings-view-model.escalation-map.test.ts` asserts whole ladder chains, and a key that
stops being a rung target (a demoted Sonnet kept for pinned rows) becomes its own chain root there. When a
slug moves on one provider only, the shared undotted `claude-sonnet-5` splits: claude-code and Copilot
rows no longer carry the same id (the e2e `settings.test.ts` comment relied on that).

## The inverse case: a preset-only model migration

Retiring a model from the curated presets WITHOUT touching the catalog (e.g. the Haiku 4.5 →
Sonnet 5-at-`low` move) does **not** trip the fingerprint gate — that gate hashes catalog ids, not
preset rows. The real fences live in `tests/unit/business/settings/presets.test.ts`: the
`retiring cheap tier` set (add the slug there so the matrices can't regress onto it), the
per-family readiness assertion, and the per-preset matrix blocks. `presets.ts` also carries prose
in three docstrings (economic "cheap tier", fast-family "not haiku", the hoisted-const comment)
that no test guards. `.claude/docs/AI-SETTINGS.md` restates the same prose and also goes stale.

When a cheap-tier MODEL disappears, the cost intent has to move into the effort column: pin
`effort: 'low'` on each migrated row, because an absent effort inherits the preset's global (`high`
on economic / strong-gate) and silently raises spend.

Touchpoints that usually need NO change on a pure catalog add: `escalation-map.ts` (rungs name only claude/gpt slugs),
`context-window.ts` (Copilot/Codex windows are deliberately omitted — the CLIs don't surface them),
`suspended-models.ts` (empty by design, kept as a kill-switch mechanism), `effort.ts`,
`validate-model.ts` (generic), and `business/settings/{defaults,presets}.ts`.

## The settings.ts duplicate-string hazard

`settings.ts` hoists `PROVIDER_CLAUDE_CODE` / `PROVIDER_GITHUB_COPILOT` / `PROVIDER_OPENAI_CODEX` as
constants precisely because `sonarjs/no-duplicate-string` trips at 3 identical raw literals. Adding a
provider-keyed table (like `RETIRED_MODEL_REMAPS`) that spells the ids out raw pushes the file over the
threshold and fails lint.

**Reuse those constants at every `z.literal()` / comparison site** — schema definitions, migration
tables, row-shape guards — rather than adding raw occurrences.

**General rule:** `pnpm lint` is `eslint . --max-warnings 0`, so ANY new warning anywhere in the diff
fails the gate, even in a file whose existing complexity warnings have nothing to do with your change.
Re-run lint before landing and treat a new warning in a touched file as yours to fix by
constant-hoisting — check `git diff <file>` for the literal before assuming it predates you.

Related: [[project_release_gate_seams]], [[seams_escalation_ladder]],
[[seams_provider_conformance_and_demo]].
