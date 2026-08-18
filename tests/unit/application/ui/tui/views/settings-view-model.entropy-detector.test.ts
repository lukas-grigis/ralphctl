/**
 * Settings view-model — the `harness.entropyPlateauDetector` row. Follows the boolean-knob pattern
 * (`kind: 'select'`, like `escalateOnPlateau` / `skipPreVerifyOnFreshSetup`): a closed true/false
 * picker, shipped off.
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

describe('buildSections — harness.entropyPlateauDetector row', () => {
  it('renders as a true/false select showing the shipped default (false)', () => {
    const row = harnessFields(DEFAULT_SETTINGS).find((f) => f.key === 'harness.entropyPlateauDetector');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('select');
    expect(row?.current).toBe('false');
  });

  it('reflects an opted-in value', () => {
    const optedIn: Settings = {
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, entropyPlateauDetector: true },
    };
    const row = harnessFields(optedIn).find((f) => f.key === 'harness.entropyPlateauDetector');
    expect(row?.current).toBe('true');
  });

  it('has a HARNESS_HINTS entry naming the default-off posture', () => {
    const hint = HARNESS_HINTS['harness.entropyPlateauDetector'];
    expect(hint).toBeDefined();
    expect(hint).toMatch(/[Oo]ff by default/);
  });
});
