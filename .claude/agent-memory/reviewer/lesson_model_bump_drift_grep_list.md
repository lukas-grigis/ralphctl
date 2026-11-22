---
name: model-bump-drift-grep-list
description: What the catalog-fingerprint gate misses on a model bump and where drift lands
metadata:
  type: feedback
---

The catalog-fingerprint test in `tests/unit/business/task/escalation-map.test.ts` covers ladder lockstep and orphaned
rungs. Recompute the recorded hashes independently (sha256 of sorted ids joined by `\n`, first 16 hex chars) to
confirm the implementer ran the test rather than hand-writing them.

**What it does not cover:** behaviour duplicated outside the catalogs (see
[[lesson_second_implementation_of_shared_rule]]), and comments or docblocks naming model ids, effort vocabularies, or
which model is suspended: provider adapters, `_engine/ai-session.ts`, `resolve-agent-override.ts`, TUI docblocks in
the settings editor, settings view-model and header card.

Drift classes that recur on every refresh (all gate-green):

- A constant flip (`FABLE`, codex flagship) leaves price ratios ("2.5x Opus") and "X drives the evaluator" prose in
  `preset-model-ids.ts`, `escalation-map.ts`, `defaults.ts`, `mixed-preset-matrices.ts` describing the old id.
- Future-tense retirement prose ("stays until it retires on <date>") survives the retirement itself.
- Catalog refresh-history paragraphs count remaps ("the two with a successor are remapped"); deleting a dead remap
  row makes the count false. Grep the catalog file for "remapped" whenever `RETIRED_MODEL_REMAPS` loses a row.
- `PRESET_MODEL_FALLBACKS` keys go unreachable when presets stop stamping a model: `adaptAiToAvailableModels` runs only
  inside the apply-preset flow on freshly stamped rows, so a key no preset/default stamps is dead. Probe with a tsx
  script enumerating `applyPreset(p, DEFAULT_SETTINGS)` + `defaultAiSettingsForProvider(p)` rows.
- Copilot CLI ≥1.0.114 ships a packed binary: `grep -a` finds no model ids at all. `copilot help config` prints a
  (non-exhaustive) model list; the extracted `runtime.node` lives under `~/Library/Caches/copilot/pkg/<plat>/<ver>`.

**How to apply:** grep the id, the old constant's name, price multiples and the retirement date across all of `src/`,
not only the changed modules. See also [[lesson_data_driven_branch_loses_coverage]].
