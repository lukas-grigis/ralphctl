---
name: model-bump-drift-grep-list
description: What the catalog-fingerprint gate misses on a model bump and where drift lands
metadata:
  type: feedback
---

The catalog-fingerprint test in `tests/unit/business/task/escalation-map.test.ts` covers ladder lockstep and orphaned
rungs. Recompute the recorded hashes independently (sha256 of sorted ids, first 16 hex chars) to confirm the
implementer ran the test rather than hand-writing them.

**What it does not cover:** behaviour duplicated outside the catalogs (see
[[lesson_second_implementation_of_shared_rule]]), and comments or docblocks naming model ids, effort vocabularies, or
which model is suspended: provider adapters, `_engine/ai-session.ts`, `resolve-agent-override.ts`, TUI docblocks in
the settings editor, settings view-model and header card.

**How to apply:** grep the id and effort-level strings across all of `src/`, not only the changed modules.
