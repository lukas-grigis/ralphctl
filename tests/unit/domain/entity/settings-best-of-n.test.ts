/**
 * Default + range contract for `settings.harness.bestOfNCandidates` — the top-of-ladder remedy
 * above the same-model nudge. Genuinely optional (no schema default): `DEFAULT_SETTINGS` ships the
 * minimum useful `2` (the rung is reachable on a fresh install), `0` disables it — what the
 * `*-economic` presets pin — and the field itself is omittable so hand-built `Settings` literals
 * elsewhere in the codebase (that predate this field) keep validating unchanged.
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applyPreset } from '@src/business/settings/presets.ts';

const harnessWithoutBestOfN = (): unknown => {
  const { bestOfNCandidates, ...rest } = DEFAULT_SETTINGS.harness;
  void bestOfNCandidates;
  return { ...DEFAULT_SETTINGS, harness: rest };
};

describe('settings.harness.bestOfNCandidates', () => {
  it('DEFAULT_SETTINGS ships the rung enabled at the minimum useful N of 2', () => {
    expect(DEFAULT_SETTINGS.harness.bestOfNCandidates).toBe(2);
  });

  it('the shipped default is a value the schema accepts (the rung is reachable on a fresh install)', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.bestOfNCandidates).toBe(2);
  });

  it('each *-economic preset pins the cost opt-out of 0 over the shipped default', () => {
    for (const preset of ['mixed-economic', 'claude-economic', 'copilot-economic', 'codex-economic'] as const) {
      expect(applyPreset(preset, DEFAULT_SETTINGS).harness.bestOfNCandidates, preset).toBe(0);
    }
  });

  it('is genuinely optional — an omitted field still validates (no default materialises)', () => {
    const parsed = SettingsSchema.safeParse(harnessWithoutBestOfN());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.bestOfNCandidates).toBeUndefined();
  });

  it('accepts 0 (disabled) and each integer in [2, 4]', () => {
    for (const n of [0, 2, 3, 4]) {
      const parsed = SettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        harness: { ...DEFAULT_SETTINGS.harness, bestOfNCandidates: n },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.harness.bestOfNCandidates).toBe(n);
    }
  });

  it('rejects 1 — the gap between disabled (0) and the minimum useful N (2)', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, bestOfNCandidates: 1 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects 5 — above the ceiling', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, bestOfNCandidates: 5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer value', () => {
    const parsed = SettingsSchema.safeParse({
      ...DEFAULT_SETTINGS,
      harness: { ...DEFAULT_SETTINGS.harness, bestOfNCandidates: 2.5 },
    });
    expect(parsed.success).toBe(false);
  });
});
