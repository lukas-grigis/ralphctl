import { describe, expect, it } from 'vitest';
import { applyPreset } from '@src/business/settings/presets.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { diffPreset, diffSettings } from '@src/application/ui/tui/views/settings-preset-diff.ts';

const claudeOnly = applyPreset('claude-only', DEFAULT_SETTINGS);

describe('diffPreset', () => {
  it('claude-only → claude-economic lists the implement generator model row', () => {
    const { changed, unchanged } = diffPreset('claude-economic', claudeOnly);
    const row = changed.find((c) => c.setting === 'ai.implement.generator.model');
    expect(row).toBeDefined();
    expect(row?.now).not.toBe(row?.after);
    expect(changed.some((c) => c.setting === 'harness.bestOfNCandidates')).toBe(true);
    expect(unchanged).toContain('ai.createPr.model');
  });

  it("applying the active preset's own values changes nothing", () => {
    const { changed, unchanged } = diffPreset('claude-only', claudeOnly);
    expect(changed).toEqual([]);
    expect(unchanged.length).toBeGreaterThan(10);
  });

  it('counts every compared value once', () => {
    const { changed, unchanged } = diffSettings(claudeOnly, applyPreset('claude-economic', claudeOnly));
    expect(new Set([...changed.map((c) => c.setting), ...unchanged]).size).toBe(changed.length + unchanged.length);
  });
});
