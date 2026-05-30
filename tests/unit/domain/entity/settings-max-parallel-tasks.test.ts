/**
 * Clamp contract for `settings.concurrency.maxParallelTasks`: the schema accepts `[1, 5]` and
 * rejects anything above the parallel ceiling. The wave scheduler re-clamps to the same bound,
 * but the schema is the first line of defence against a hand-edited settings file asking for
 * more concurrency than the harness supports.
 */

import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const withMaxParallel = (maxParallelTasks: number): unknown => ({
  ...DEFAULT_SETTINGS,
  concurrency: { ...DEFAULT_SETTINGS.concurrency, maxParallelTasks },
});

describe('settings.concurrency.maxParallelTasks clamp', () => {
  it('rejects 6 (above the ceiling of 5)', () => {
    const parsed = SettingsSchema.safeParse(withMaxParallel(6));
    expect(parsed.success).toBe(false);
  });

  it('accepts 5 (the ceiling)', () => {
    const parsed = SettingsSchema.safeParse(withMaxParallel(5));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concurrency.maxParallelTasks).toBe(5);
  });

  it('accepts 1 (the serial default, unchanged)', () => {
    const parsed = SettingsSchema.safeParse(withMaxParallel(1));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.concurrency.maxParallelTasks).toBe(1);
  });
});
