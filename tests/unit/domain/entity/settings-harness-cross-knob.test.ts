/**
 * Cross-knob invariant: `settings.harness.maxTurns` must be ≥ `plateauThreshold`.
 *
 * When `maxTurns < plateauThreshold` the plateau window can never fill within one attempt
 * (plateauHistory resets per attempt) so `escalateOnPlateau` and all downstream remedies
 * — model escalation, same-model nudge — become permanently unreachable. The schema rejects
 * such a configuration so the operator sees a clear error message rather than silently broken
 * escalation.
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const withHarness = (overrides: Partial<typeof DEFAULT_SETTINGS.harness>): unknown => ({
  ...DEFAULT_SETTINGS,
  harness: { ...DEFAULT_SETTINGS.harness, ...overrides },
});

describe('settings.harness maxTurns ≥ plateauThreshold cross-knob invariant', () => {
  it('rejects maxTurns < plateauThreshold (1 < 2)', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 1, plateauThreshold: 2 }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.includes('maxTurns'));
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/maxTurns.*plateauThreshold/);
  });

  it('rejects maxTurns < plateauThreshold (3 < 5)', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 3, plateauThreshold: 5 }));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((i) => i.path.includes('maxTurns'));
    expect(issue).toBeDefined();
  });

  it('accepts maxTurns === plateauThreshold (2 === 2, minimum valid)', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 2, plateauThreshold: 2 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(2);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('accepts maxTurns > plateauThreshold (5 > 2, the default posture)', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 5, plateauThreshold: 2 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(5);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('accepts DEFAULT_SETTINGS as-is (maxTurns=5, plateauThreshold=2)', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
  });

  it('accepts maxTurns=10, plateauThreshold=5 (both at ceiling)', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 10, plateauThreshold: 5 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(10);
    expect(parsed.data.harness.plateauThreshold).toBe(5);
  });
});
