/**
 * Settings view-model — the `harness.bestOfNCandidates` row. Follows the existing numeric-knob
 * pattern (`kind: 'text'`, like `maxTurns` / `plateauThreshold`): a free-text field validated at
 * the schema boundary, not a closed picker, even though the domain range is the small {0, 2-4}
 * set.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { Settings } from '@src/domain/entity/settings.ts';
import { buildSections, HARNESS_HINTS } from '@src/application/ui/tui/views/settings-view-model.ts';

const harnessFields = (s: Settings): ReturnType<typeof buildSections>[number]['fields'] => {
  const section = buildSections(s).find((sec) => sec.id === 'harness');
  if (section === undefined) throw new Error('harness section missing');
  return section.fields;
};

describe('buildSections — harness.bestOfNCandidates row', () => {
  it('renders as a text field showing the disabled default (0)', () => {
    const fields = harnessFields(DEFAULT_SETTINGS);
    const row = fields.find((f) => f.key === 'harness.bestOfNCandidates');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('text');
    expect(row?.current).toBe('0');
  });

  it('reflects a non-default value', () => {
    const withKnobOn: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, bestOfNCandidates: 3 },
    };
    const fields = harnessFields(withKnobOn);
    const row = fields.find((f) => f.key === 'harness.bestOfNCandidates');
    expect(row?.current).toBe('3');
  });

  it('falls back to 0 when the field is absent (genuinely-optional schema, no default materialised)', () => {
    const { bestOfNCandidates: _drop, ...harnessWithout } = DEFAULT_SETTINGS.harness;
    void _drop;
    const withoutField: Settings = { ...DEFAULT_SETTINGS, harness: harnessWithout as Settings['harness'] };
    const fields = harnessFields(withoutField);
    const row = fields.find((f) => f.key === 'harness.bestOfNCandidates');
    expect(row?.current).toBe('0');
  });

  it('has a HARNESS_HINTS entry naming the cost caveat', () => {
    const hint = HARNESS_HINTS['harness.bestOfNCandidates'];
    expect(hint).toBeDefined();
    expect(hint).toMatch(/0 disables/);
  });
});
