---
name: settings-default-flip-surfaces
description: Flipping a settings.harness default has ~6 untested restatement surfaces (TUI hint, 5 docs) plus a preset-pin seam; only the two settings tests fail on their own
metadata:
  type: project
---

Changing a `settings.harness.*` DEFAULT value in `src/business/settings/defaults.ts` touches more
surfaces than the type system or the test suite will catch.

**Why:** the default value is restated in prose in at least six places that no test asserts, so a flip
leaves silent drift. Observed while flipping `bestOfNCandidates` 0 → 2 (2026-08-14): only
`tests/unit/domain/entity/settings-<knob>.test.ts` and the settings-view-model row test failed; every
doc claim stayed green and wrong.

**How to apply:** after editing `defaults.ts`, grep the knob name across `src/` and `.claude/docs/` and
fix each restatement:

- `src/domain/entity/settings.ts` — the Zod field's JSDoc names the default.
- `src/application/ui/tui/views/settings-view-model.ts` — `HARNESS_HINTS[<key>]` prose names the
  default and renders in the TUI settings panel (its test greps a substring of the hint, so reword
  carefully).
- `.claude/docs/` — `AI-SETTINGS.md` (harness key list + "Default escalation posture"),
  `PERFORMANCE.md`, `WORKFLOWS.md`, `ARCHITECTURE.md`, `RESEARCH-REFERENCES.md`, and
  `HARNESS-PRINCIPLES.md` each restate escalation/harness defaults independently.

**Preset pin seam:** `applyPreset` (`business/settings/presets.ts`) historically stamped only `ai` +
`harness.escalateOnPlateau`; every other harness key was preserved from `current`. A preset that must
take a position on a knob (e.g. the four `*-economic` presets pinning `bestOfNCandidates: 0`) declares
it as an OPTIONAL field on the `PRESETS` record entry, and `applyPreset` conditionally spreads it —
presets that omit it still leave the operator's value untouched. Test it by seeding a non-default value
in `current` so "overwritten" and "preserved" are distinguishable.

Related: [[seams_model_catalog_refresh]].
