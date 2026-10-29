/** Tokens unit tests — responsive helpers and glyph tokens from theme/tokens.ts. */

import { describe, expect, it } from 'vitest';
import { breakpointFor, glyphs } from '@src/application/ui/tui/theme/tokens.ts';

describe('breakpointFor', () => {
  it('floors at sm for any non-negative width below the md threshold', () => {
    expect(breakpointFor(0)).toBe('sm');
    expect(breakpointFor(80)).toBe('sm');
    expect(breakpointFor(99)).toBe('sm');
  });

  it('picks the largest matching breakpoint', () => {
    expect(breakpointFor(100)).toBe('md');
    expect(breakpointFor(139)).toBe('md');
    expect(breakpointFor(140)).toBe('lg');
    expect(breakpointFor(179)).toBe('lg');
    expect(breakpointFor(180)).toBe('xl');
    expect(breakpointFor(219)).toBe('xl');
    expect(breakpointFor(220)).toBe('xxl');
  });
});

describe('glyphs.clipMarkers (audit-[03])', () => {
  it('exposes the single-line clip marker as U+2026 (horizontal ellipsis)', () => {
    expect(glyphs.clipEllipsis).toBe('…');
    expect(glyphs.clipEllipsis).toHaveLength(1);
    expect(glyphs.clipEllipsis.codePointAt(0)).toBe(0x2026);
  });

  it('exposes the multi-line collapse marker as `▼ more` (expand affordance)', () => {
    expect(glyphs.collapseExpand).toBe('▼ more');
  });
});

describe('glyphs — design-system tokens for former inline glyphs (#297)', () => {
  it('exposes the picker focus rail as U+258D (left three-eighths block)', () => {
    expect(glyphs.focusBar).toHaveLength(1);
    expect(glyphs.focusBar.codePointAt(0)).toBe(0x258d);
  });

  it('exposes the progress-bar cells as U+2588 / U+2591 (full block / light shade)', () => {
    expect(glyphs.barFilled.codePointAt(0)).toBe(0x2588);
    expect(glyphs.barEmpty.codePointAt(0)).toBe(0x2591);
  });

  it('exposes the unknown-verdict glyph as a plain ASCII question mark', () => {
    expect(glyphs.unknownGlyph).toBe('?');
  });
});
