/**
 * Default + range contract for `settings.harness.plateauThreshold`. The patient default is 3
 * (raised from 2) so the graduated remedy ladder does not spend an escalation rung on a stall the
 * generator would have broken on its own; the [2, 5] range is unchanged.
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const harnessWithoutPlateauThreshold = (): unknown => {
  const { plateauThreshold, ...rest } = DEFAULT_SETTINGS.harness;
  void plateauThreshold;
  return { ...DEFAULT_SETTINGS, harness: rest };
};

describe('settings.harness.plateauThreshold', () => {
  it('DEFAULT_SETTINGS carries the patient default of 3', () => {
    expect(DEFAULT_SETTINGS.harness.plateauThreshold).toBe(3);
  });

  it('schema defaults an omitted plateauThreshold to 3', () => {
    const parsed = SettingsSchema.safeParse(harnessWithoutPlateauThreshold());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.plateauThreshold).toBe(3);
  });

  it('keeps the [2, 5] range — rejects 1, accepts 5', () => {
    const tooLow = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, plateauThreshold: 1 },
    });
    expect(tooLow.success).toBe(false);

    const ceiling = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, plateauThreshold: 5 },
    });
    expect(ceiling.success).toBe(true);
    if (!ceiling.success) return;
    expect(ceiling.data.harness.plateauThreshold).toBe(5);
  });
});
