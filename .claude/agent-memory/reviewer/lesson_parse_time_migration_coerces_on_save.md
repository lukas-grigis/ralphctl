---
name: parse-time-migration-coerces-on-save
description: A retired-value migration done as a zod preprocess also fires inside save(), so a CLI set can echo one value and persist another
metadata:
  type: feedback
---

`migrateStaleRow` (retired model remap, codex `minimal` and grok `none`/`minimal` -> `low`) lives in the `AiSettingsSchema`
preprocess in `domain/entity/settings.ts`. `JsonSettingsRepository.save()` runs the same `SettingsSchema.safeParse`, so
the migration is not parse-only: `ralphctl settings set ai.refine.effort none` on a Grok row passes `applySettingsKey`,
prints `ai.refine.effort = none`, and persists `low`. A genuinely bogus value (`bogus`) is rejected, so the only
silent-coercion window is the retired vocabulary. Verified with a tsx probe (apply-key then `SettingsSchema.safeParse`).

**Why:** the gate tests the load path (`lifts a saved grok effort`) and the apply-key path separately, never the
composition, so the mismatch is invisible.

**How to apply:** when a diff adds a value to a preprocess migration, also ask what the write path does with that value.
The fix belongs in `apply-key.ts` (validate the typed effort against `PROVIDER_EFFORT_LEVELS[row.provider]` before it
reaches `save`) so the user gets an error instead of a success line that lies.
