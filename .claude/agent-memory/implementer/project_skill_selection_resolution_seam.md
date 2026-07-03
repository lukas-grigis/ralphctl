---
name: skill-selection-resolution-seam
description: The ONE skill-selection resolution point — createResolvedSkillSource decorator wraps the composed
  SkillSource in the launcher; dedupe last-wins + disabled subtraction; getByName passes through unfiltered
metadata:
  type: project
---

Opt-in/opt-out skill loading (#216 T4) resolves at exactly ONE point: `createResolvedSkillSource`
(`src/integration/ai/skills/_engine/resolve-selection.ts`), a pure `SkillSource` decorator wired inside
`buildComposedSkillSource` in `src/application/ui/shared/launcher.ts`. No leaf/adapter filters skills.

**Why:** the plan required a single seam that a future v2 relevance recommender can replace behind the same
`SkillSource` contract without touching install-skills leaves or adapters.

**How to apply:**

- Composition ORDER is load-bearing: `composeSkillSources(bundled, project, operator, phase)` — phase LAST.
  The decorator's `getForFlow` dedupes by install `name` keeping the LAST occurrence, so a phase-folder copy
  (catalog copy-on-enable) shadows the bundled default. Dedupe is a no-op when names are unique (zero-config
  byte-identical to pre-decorator behaviour — fenced by `launcher-composition.test.ts`).
- `getForFlow` = dedupe THEN subtract `flowDisabled(flowId)`. `getByName` passes through UNFILTERED/un-deduped:
  it's a name-RESOLUTION seam (readiness `offer-skill-suggestions` uses it to tell known-bundled from unknown),
  NOT an install seam. Filtering it would mislabel an opted-out skill as "unknown" and scaffold a wrong stub.
- `flowDisabled` is run-scoped in the launcher: saved `settings.ai.skills[flow].disabled` unioned with per-run
  `LaunchExtras.skillsOverride.disabled` (new field, applies to ANY skill name). Duplicates collapse in a Set.
- ALIASED-FLOW RULE (one everywhere): the saved-preference key is resolved from the DISPATCHED orchestration id
  via the existing `aiFlowIdFor` (kebab→camel): `create-pr`→`createPr`, `review`→`implement`,
  `detect-scripts`/`detect-skills`→`readiness`. So a review launch inherits implement's disabled row.
- Only refine/plan/implement/readiness/ideate actually mount skills via `ctx.skillSource`. review/detect-*
  don't pass `skillSource` to their flow, so their `getForFlow` is never called (aliasing still resolves the key
  harmlessly). create-pr has NO launch case in `launchFlow`'s dispatch switch today.
- `buildComposedSkillSource` is exported (@public) so the composition fence test drives the REAL wiring rather
  than a reconstruction that could drift.
