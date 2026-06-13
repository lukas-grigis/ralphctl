/**
 * The Settings editor flags temporarily-suspended models in the model-select LABEL only; the
 * underlying option VALUE stays the bare catalog id so a pre-pinned choice round-trips and the
 * adapter guard is the single rejection point. `buildSections` therefore keeps the bare ids in
 * `field.options` — the suffix is applied at render time in `settings-editor.tsx`, gated on
 * `isModelField`. These tests pin that seam: model fields are detected, non-model selects are not,
 * and the suspended fable id is present (bare) in the model options.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { buildSections, isModelField } from '@src/application/ui/tui/views/settings-view-model.ts';

const fieldByKey = (sections: ReturnType<typeof buildSections>, key: string) => {
  for (const section of sections) {
    const field = section.fields.find((f) => f.key === key);
    if (field !== undefined) return field;
  }
  throw new Error(`no field with key ${key}`);
};

describe('isModelField', () => {
  const sections = buildSections(DEFAULT_SETTINGS);

  it('is true for per-flow / per-role model selects', () => {
    expect(isModelField(fieldByKey(sections, 'ai.refine.model'))).toBe(true);
    expect(isModelField(fieldByKey(sections, 'ai.implement.generator.model'))).toBe(true);
    expect(isModelField(fieldByKey(sections, 'ai.implement.evaluator.model'))).toBe(true);
  });

  it('is false for provider, effort, and non-AI selects', () => {
    expect(isModelField(fieldByKey(sections, 'ai.refine.provider'))).toBe(false);
    expect(isModelField(fieldByKey(sections, 'ai.refine.effort'))).toBe(false);
    expect(isModelField(fieldByKey(sections, 'logging.level'))).toBe(false);
  });

  it('keeps the suspended fable id BARE in the model options (suffix is render-time only)', () => {
    const field = fieldByKey(sections, 'ai.refine.model');
    if (field.kind !== 'select') throw new Error('expected a select field');
    expect(field.options).toContain('claude-fable-5');
    expect(field.options).not.toContain('claude-fable-5 (suspended)');
  });
});
