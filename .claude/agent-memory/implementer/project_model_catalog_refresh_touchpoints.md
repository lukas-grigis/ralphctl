---
name: project-model-catalog-refresh-touchpoints
description: Hidden touchpoints when refreshing a provider model catalog (copilot.ts / claude.ts /
  codex.ts) — the sha256 catalog fingerprint gate, where RETIRED_MODEL_REMAPS is actually tested,
  and the AI-SETTINGS.md prose restatement
metadata:
  type: project
---

A provider model-catalog refresh touches three places that are NOT reachable by grepping for the
changed slugs:

1. **`tests/unit/business/task/escalation-map.test.ts` — catalog fingerprint gate.** It asserts
   `fingerprint(CLAUDE_MODELS/CODEX_MODELS/COPILOT_MODELS)`, a 16-hex-char truncated sha256 of the
   sorted ids joined by `\n`. ANY catalog edit fails it by design (it mechanizes the
   HARNESS-PRINCIPLES.md § 18 model-bump audit). Recompute with
   `npx tsx -e "import {createHash} from 'node:crypto'; import {COPILOT_MODELS} from './src/domain/value/settings-models/copilot.ts'; console.log(createHash('sha256').update([...COPILOT_MODELS].sort().join('\n')).digest('hex').slice(0,16))"`.
   The same file also has lockstep tests asserting every `DEFAULT_ESCALATION_MAP` key AND value is
   a member of some catalog — a rename/delist of a slug that appears in a ladder rung fails there.
2. **`RETIRED_MODEL_REMAPS` coverage lives in `tests/unit/business/settings/implement-shape.test.ts`**
   (describe block still named "retired claude-opus-4-7 migration"), NOT in
   `json-settings-repository.test.ts` — the repository test only covers the file-level load path.
   Both are worth extending: implement-shape for schema-level remap + provider-guard proof,
   json-settings-repository for a real persisted-file → `load()` round trip that also asserts the
   on-disk file is left untouched (the remap is read-time only, no rewrite until the next `save()`).
3. **`.claude/docs/AI-SETTINGS.md`** restates each catalog in prose, including a model COUNT
   ("lists 31 models …") and an "Added since the last reconciliation" / "Removed" paragraph. It
   goes stale silently — no test guards it.

**Why:** the July-2026 refresh (`4c2acfba`) established this shape; the fingerprint gate exists
precisely so a catalog bump cannot land without someone re-walking the audit.

**How to apply:** on any catalog change, sweep in this order — catalog file → `RETIRED_MODEL_REMAPS`
in `src/domain/entity/settings.ts` → fingerprint → the two remap test files → AI-SETTINGS.md →
CHANGELOG. Touchpoints that usually need NO change (verified 2026-08-18 copilot pass):
`escalation-map.ts` (rungs name only claude/gpt slugs), `context-window.ts` (Copilot/Codex windows
are deliberately omitted — the CLIs don't surface them), `suspended-models.ts` (empty by design,
kept as a kill-switch mechanism), `effort.ts`, `validate-model.ts` (generic), and
`business/settings/{defaults,presets}.ts`. See
[[project_provider_literal_duplication_lint_cap]] for the settings.ts lint hazard when growing the
remap table.
