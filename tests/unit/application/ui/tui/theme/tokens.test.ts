/**
 * Tokens unit tests — covers the responsive helpers exported from theme/tokens.ts.
 *
 * `resolveRailWidth` is the Execute view's authoritative rail-width decision. Verified across
 * the breakpoint thresholds so a regression in either the `lg` floor (fixed 28) or the `xl`
 * fluid curve (36..56, ratio 0.22) surfaces here, not in a downstream rendering test.
 */

import { describe, expect, it } from 'vitest';
import { breakpointFor, fluid, glyphs, resolveRailWidth, RAIL_WIDTH } from '@src/application/ui/tui/theme/tokens.ts';

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

describe('fluid', () => {
  it('clamps below min and above max', () => {
    expect(fluid(50, { min: 28, max: 40, ratio: 0.18 })).toBe(28);
    expect(fluid(5000, { min: 28, max: 40, ratio: 0.18 })).toBe(40);
  });

  it('returns floor(columns * ratio) inside the band', () => {
    // 200 * 0.18 = 36 — inside [28, 40].
    expect(fluid(200, { min: 28, max: 40, ratio: 0.18 })).toBe(36);
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

describe('resolveRailWidth', () => {
  it('returns the fixed RAIL_WIDTH below the xl breakpoint', () => {
    // sm / md / lg all share the fixed value — the two-column layout has no context column to
    // compete with, so a wider rail would steal pixels from the Tasks stream.
    expect(resolveRailWidth(80)).toBe(RAIL_WIDTH);
    expect(resolveRailWidth(120)).toBe(RAIL_WIDTH);
    expect(resolveRailWidth(140)).toBe(RAIL_WIDTH);
    expect(resolveRailWidth(179)).toBe(RAIL_WIDTH);
  });

  it('grows fluidly at xl+ (180 → 39, 260 → 56 cap)', () => {
    // 180 * 0.22 = 39.6 → floor 39. The first xl tick lands here.
    expect(resolveRailWidth(180)).toBe(39);
    // 200 * 0.22 = 44 — exact integer.
    expect(resolveRailWidth(200)).toBe(44);
    // 220 * 0.22 = 48.4 → floor 48.
    expect(resolveRailWidth(220)).toBe(48);
    // 260 * 0.22 = 57.2 → clamped to max (56).
    expect(resolveRailWidth(260)).toBe(56);
    // Asymptote check — any extreme width still clamps.
    expect(resolveRailWidth(5000)).toBe(56);
  });
});
