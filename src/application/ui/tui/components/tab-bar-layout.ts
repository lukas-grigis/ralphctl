/**
 * Pure layout for the one-row tab bar. No React, no Ink: it returns whole-cell segments so the
 * component only paints them and a test can assert on the plain text at any width.
 *
 *   ` ralphctl │ [1 Work]  2 Sprints   3 Projects   4 Runs ●1   5 System ✚2      ? help `
 *
 * The active tab is wrapped in `[ ]` — the NO_COLOR cue; colour adds primary + bold on top.
 * Below `lg` badges are compact (`●N`, `✚N`) and the right side is `? help`; at `lg` and wider
 * they are spelled out (`● N live`, `✚ N warning(s)`) and the right side also carries the
 * version and, when one exists, the available update.
 *
 * Width is measured in code points (every glyph in `tokens.ts` is one cell). When the full form
 * does not fit, the layout degrades in order — drop the wordmark, then the tab padding, then the
 * badges, then the right side — so all five labels always survive whole.
 */

import { breakpoints, glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { SECTIONS, type SectionId } from '@src/application/ui/tui/runtime/nav-tree.ts';

export type TabTone = 'brand' | 'dim' | 'active' | 'tab' | 'live' | 'warn' | 'fail' | 'update';

export interface TabSegment {
  readonly text: string;
  readonly tone: TabTone;
}

export interface TabBadges {
  /** Sessions currently running. */
  readonly runsLive: number;
  /** Doctor probes at `warn`. */
  readonly doctorWarn: number;
  /** Doctor probes at `fail`. */
  readonly doctorFail: number;
}

export interface TabLayoutInput {
  readonly columns: number;
  readonly active: SectionId | 'none';
  readonly badges: TabBadges;
  /** Current version, shown from `lg` up. */
  readonly version: string;
  /** Newer version on the registry, when one exists. */
  readonly latest?: string | undefined;
}

export interface TabLayout {
  readonly segments: readonly TabSegment[];
  /** The segments joined — exactly what is painted. */
  readonly text: string;
  /** Code-point width of {@link text}; never above `columns`. */
  readonly width: number;
}

const width = (s: string): number => [...s].length;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Badge for a tab as `{ text, tone }`, or `undefined` when there is nothing to show. */
const badgeFor = (
  id: SectionId,
  badges: TabBadges,
  verbose: boolean
): { readonly text: string; readonly tone: TabTone } | undefined => {
  if (id === 'runs' && badges.runsLive > 0) {
    const n = String(badges.runsLive);
    return { text: verbose ? `${glyphs.busyDot} ${n} live` : `${glyphs.busyDot}${n}`, tone: 'live' };
  }
  if (id === 'system' && (badges.doctorFail > 0 || badges.doctorWarn > 0)) {
    const failing = badges.doctorFail > 0;
    const n = failing ? badges.doctorFail : badges.doctorWarn;
    const text = verbose
      ? `${glyphs.stethoscope} ${String(n)} ${failing ? 'failing' : plural(n, 'warning', 'warnings')}`
      : `${glyphs.stethoscope}${String(n)}`;
    return { text, tone: failing ? 'fail' : 'warn' };
  }
  return undefined;
};

interface Variant {
  readonly wordmark: boolean;
  /** Padding cells on each side of an inactive tab. */
  readonly pad: number;
  readonly gap: number;
  readonly badges: boolean;
  readonly right: 'full' | 'help' | 'none';
}

const VARIANTS: readonly Variant[] = [
  { wordmark: true, pad: 1, gap: 1, badges: true, right: 'full' },
  { wordmark: false, pad: 1, gap: 1, badges: true, right: 'full' },
  { wordmark: false, pad: 1, gap: 0, badges: true, right: 'help' },
  { wordmark: false, pad: 0, gap: 1, badges: true, right: 'help' },
  { wordmark: false, pad: 0, gap: 1, badges: false, right: 'help' },
  { wordmark: false, pad: 0, gap: 1, badges: false, right: 'none' },
];

const spaces = (n: number): string => ' '.repeat(Math.max(0, n));

const leftSegments = (input: TabLayoutInput, v: Variant, verbose: boolean): TabSegment[] => {
  const out: TabSegment[] = [{ text: ' ', tone: 'dim' }];
  if (v.wordmark) {
    out.push({ text: 'ralphctl', tone: 'brand' }, { text: ` ${glyphs.pipe} `, tone: 'dim' });
  }
  SECTIONS.forEach((section, i) => {
    if (i > 0) out.push({ text: spaces(v.gap), tone: 'dim' });
    const isActive = section.id === input.active;
    const badge = v.badges ? badgeFor(section.id, input.badges, verbose) : undefined;
    const label = `${section.digit} ${section.label}`;
    const tone: TabTone = isActive ? 'active' : 'tab';
    // The active tab trades its side padding for `[ ]`, so every tab keeps the same footprint.
    out.push({ text: isActive ? '[' : spaces(v.pad), tone });
    out.push({ text: label, tone });
    if (badge !== undefined) {
      out.push({ text: ' ', tone }, { text: badge.text, tone: badge.tone });
    }
    out.push({ text: isActive ? ']' : spaces(v.pad), tone });
  });
  return out;
};

const rightSegments = (input: TabLayoutInput, v: Variant, verbose: boolean): TabSegment[] => {
  if (v.right === 'none') return [];
  const out: TabSegment[] = [{ text: '? help', tone: 'dim' }];
  if (verbose && v.right === 'full') {
    out.push({ text: ` ${glyphs.bullet} v${input.version}`, tone: 'dim' });
    if (input.latest !== undefined) {
      out.push({ text: ` ${glyphs.bullet} ${glyphs.arrowUp} v${input.latest}`, tone: 'update' });
    }
  }
  return out;
};

const total = (segs: readonly TabSegment[]): number => segs.reduce((n, s) => n + width(s.text), 0);

const finish = (segments: TabSegment[], columns: number): TabLayout => {
  // Hard guarantee for absurdly narrow terminals: whole-glyph clip, never a wrapped row.
  let remaining = columns;
  const clipped: TabSegment[] = [];
  for (const seg of segments) {
    if (remaining <= 0) break;
    const cps = [...seg.text];
    clipped.push(cps.length <= remaining ? seg : { text: cps.slice(0, remaining).join(''), tone: seg.tone });
    remaining -= cps.length;
  }
  const text = clipped.map((s) => s.text).join('');
  return { segments: clipped, text, width: width(text) };
};

export const layoutTabs = (input: TabLayoutInput): TabLayout => {
  const verbose = input.columns >= breakpoints.lg;
  // Two cells kept between the tabs and the right side, one trailing margin.
  const MIN_GAP = 2;
  for (const v of VARIANTS) {
    const left = leftSegments(input, v, verbose);
    const right = rightSegments(input, v, verbose);
    const trailing = right.length > 0 ? 1 : 0;
    const used = total(left) + total(right) + trailing + (right.length > 0 ? MIN_GAP : 0);
    if (used > input.columns) continue;
    const fill = input.columns - total(left) - total(right) - trailing;
    const segments: TabSegment[] = [...left];
    if (right.length > 0) segments.push({ text: spaces(fill), tone: 'dim' }, ...right, { text: ' ', tone: 'dim' });
    return finish(segments, input.columns);
  }
  const last = VARIANTS[VARIANTS.length - 1] as Variant;
  return finish(leftSegments(input, last, false), input.columns);
};
