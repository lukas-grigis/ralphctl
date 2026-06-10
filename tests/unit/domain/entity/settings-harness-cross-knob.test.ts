/**
 * Cross-knob invariant: `settings.harness.maxTurns` must be ≥ `plateauThreshold`.
 *
 * When `maxTurns < plateauThreshold` the plateau window can never fill within one attempt
 * (plateauHistory resets per attempt) so `escalateOnPlateau` and all downstream remedies
 * — model escalation, same-model nudge — become permanently unreachable.
 *
 * CRITICALLY, a violating PERSISTED pair must SELF-HEAL at parse time, not fail: `maxTurns`
 * 1–2 was fully valid before the invariant landed, and a parse failure on upgrade bricks the
 * TUI launch AND every CLI command — including `ralphctl settings set`, the product's own
 * repair tool. The heal preserves the operator's turn budget where the schema floors allow
 * (clamp `plateauThreshold` down to `max(2, maxTurns)`), raising `maxTurns` only when forced
 * (`maxTurns === 1` → the minimum legal pair `(2, 2)`).
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const withHarness = (overrides: Partial<typeof DEFAULT_SETTINGS.harness>): unknown => ({
  ...DEFAULT_SETTINGS,
  harness: { ...DEFAULT_SETTINGS.harness, ...overrides },
});

describe('settings.harness maxTurns ≥ plateauThreshold — parse-time self-heal', () => {
  it('heals a legacy fast-iteration pair (maxTurns=2, plateauThreshold=3) by lowering the threshold', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 2, plateauThreshold: 3 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // The operator's turn budget is preserved; the threshold clamps down to it.
    expect(parsed.data.harness.maxTurns).toBe(2);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('heals maxTurns=1 to the minimum legal pair (2, 2) — the threshold floor forces the raise', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 1, plateauThreshold: 2 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(2);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('heals maxTurns=3 / plateauThreshold=5 to (3, 3) — budget preserved, window clamped', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 3, plateauThreshold: 5 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(3);
    expect(parsed.data.harness.plateauThreshold).toBe(3);
  });

  it('heals a legacy file with maxTurns=1 and NO plateauThreshold (the schema default would violate)', () => {
    const harness = { ...DEFAULT_SETTINGS.harness, maxTurns: 1 } as Record<string, unknown>;
    delete harness['plateauThreshold'];
    const parsed = SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, harness });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(2);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('accepts maxTurns === plateauThreshold (2 === 2, minimum valid) untouched', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 2, plateauThreshold: 2 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(2);
    expect(parsed.data.harness.plateauThreshold).toBe(2);
  });

  it('accepts maxTurns > plateauThreshold (5 > 3, the default posture) untouched', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 5, plateauThreshold: 3 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(5);
    expect(parsed.data.harness.plateauThreshold).toBe(3);
  });

  it('accepts DEFAULT_SETTINGS as-is (maxTurns=5, plateauThreshold=3)', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(5);
    expect(parsed.data.harness.plateauThreshold).toBe(3);
  });

  it('accepts maxTurns=10, plateauThreshold=5 (both at ceiling) untouched', () => {
    const parsed = SettingsSchema.safeParse(withHarness({ maxTurns: 10, plateauThreshold: 5 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.harness.maxTurns).toBe(10);
    expect(parsed.data.harness.plateauThreshold).toBe(5);
  });
});
