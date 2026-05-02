import { describe, it, expect } from 'vitest';
import { inkColors, glyphs, spacing, FIELD_LABEL_WIDTH } from './tokens.ts';

describe('inkColors', () => {
  it('has all required semantic tokens', () => {
    expect(inkColors.success).toMatch(/^#/);
    expect(inkColors.error).toMatch(/^#/);
    expect(inkColors.warning).toMatch(/^#/);
    expect(inkColors.info).toMatch(/^#/);
    expect(inkColors.muted).toMatch(/^#/);
    expect(inkColors.highlight).toMatch(/^#/);
    expect(inkColors.primary).toMatch(/^#/);
    expect(inkColors.secondary).toMatch(/^#/);
  });
});

describe('glyphs', () => {
  it('has phase glyphs', () => {
    expect(glyphs.phaseDone).toBe('■');
    expect(glyphs.phaseActive).toBe('◆');
    expect(glyphs.phasePending).toBe('◇');
    expect(glyphs.phaseDisabled).toBe('◌');
  });

  it('has action cursor glyphs', () => {
    expect(glyphs.actionCursor).toBe('▸');
    expect(glyphs.selectMarker).toBe('›');
  });

  it('has state glyphs', () => {
    expect(glyphs.check).toBe('✓');
    expect(glyphs.cross).toBe('✗');
    expect(glyphs.warningGlyph).toBe('⚠');
  });

  it('has spinner frames as array', () => {
    expect(Array.isArray(glyphs.spinner)).toBe(true);
    expect(glyphs.spinner.length).toBeGreaterThan(0);
  });

  it('has section markers', () => {
    expect(glyphs.badge).toBe('▣');
    expect(glyphs.sectionRule).toBe('━');
  });
});

describe('spacing', () => {
  it('has all spacing tokens as positive numbers', () => {
    expect(spacing.section).toBeGreaterThan(0);
    expect(spacing.actionBreak).toBeGreaterThan(0);
    expect(spacing.cardPadX).toBeGreaterThan(0);
    expect(spacing.indent).toBeGreaterThan(0);
    expect(spacing.gutter).toBeGreaterThan(0);
  });
});

describe('FIELD_LABEL_WIDTH', () => {
  it('is wide enough for longest label', () => {
    // "Evaluation:" = 11 chars, with padEnd we need at least 12
    expect(FIELD_LABEL_WIDTH).toBeGreaterThanOrEqual(12);
  });
});
