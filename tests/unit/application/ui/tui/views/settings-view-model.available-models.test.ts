/**
 * `buildSections` accepts an optional per-provider `availableModels` map and uses it to narrow the
 * model select options. Absent / empty map → the full catalog renders (the probe-in-flight path).
 * Populated map → the model field shows only the account-available subset for that provider.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AiProvider } from '@src/domain/entity/settings.ts';
import { buildSections, modelOptionsFor } from '@src/application/ui/tui/views/settings-view-model.ts';

/** Pull the model-field options for a given settings key out of a built section list. */
const modelOptionsForKey = (sections: ReturnType<typeof buildSections>, key: string): readonly string[] => {
  for (const section of sections) {
    const field = section.fields.find((f) => f.key === key);
    if (field !== undefined && field.kind === 'select') return field.options;
  }
  throw new Error(`no select field with key ${key}`);
};

describe('buildSections — availableModels', () => {
  it('renders the full catalog when no availableModels map is supplied', () => {
    const sections = buildSections(DEFAULT_SETTINGS);
    const provider = DEFAULT_SETTINGS.ai.refine.provider;
    expect(modelOptionsForKey(sections, 'ai.refine.model')).toEqual(modelOptionsFor(provider));
  });

  it('renders the full catalog for providers absent from a partially-populated map', () => {
    // Empty map ≈ probes still in flight: every field falls back to its full catalog.
    const sections = buildSections(DEFAULT_SETTINGS, new Map());
    const provider = DEFAULT_SETTINGS.ai.refine.provider;
    expect(modelOptionsForKey(sections, 'ai.refine.model')).toEqual(modelOptionsFor(provider));
  });

  it('narrows the model options to the supplied subset for a provider in the map', () => {
    const provider = DEFAULT_SETTINGS.ai.refine.provider;
    const fullCatalog = modelOptionsFor(provider);
    const subset = fullCatalog.slice(0, 1);
    const map = new Map<AiProvider, readonly string[]>([[provider, subset]]);

    const sections = buildSections(DEFAULT_SETTINGS, map);
    const options = modelOptionsForKey(sections, 'ai.refine.model');
    expect(options).toEqual(subset);
    // Any model excluded from the subset must not appear.
    for (const excluded of fullCatalog.slice(1)) expect(options).not.toContain(excluded);
  });
});
