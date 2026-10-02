/**
 * Pure fitting for the one-row location line. No React, no Ink; widths are code points (every glyph in `tokens.ts` is
 * one cell).
 */

import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { clipWithEllipsis } from '@src/application/ui/tui/components/format.ts';

export type LocationTone = 'badge' | 'section' | 'trail' | 'subtitle' | 'dim' | 'name' | 'key' | 'chip';

export interface LocationSegment {
  readonly text: string;
  readonly tone: LocationTone;
}

export interface LocationInput {
  /** Cells available to the whole row, margins included. */
  readonly columns: number;
  /** `lg` and wider: spell out `project` / `sprint` and append `S switch`. */
  readonly wide: boolean;
  /** Section label (`Work`). */
  readonly section: string;
  /** Labels for every entry above the section root, in stack order. */
  readonly trail: readonly string[];
  readonly subtitle?: string | undefined;
  /** Cells a caller-owned node (Execute's status chip) needs right after the left text. */
  readonly leftExtraWidth?: number;
  readonly project?: string | undefined;
  readonly sprint?: string | undefined;
  /** Sprint status, rendered as a chip (`[ACTIVE]`). */
  readonly status?: string | undefined;
}

export interface LocationLayout {
  readonly left: readonly LocationSegment[];
  readonly right: readonly LocationSegment[];
  /** `left` + `right` joined, for assertions. */
  readonly leftText: string;
  readonly rightText: string;
  /** Status chip text as painted (`[ACTIVE]`), or `undefined` when it was dropped / absent. */
  readonly chip: string | undefined;
}

/** Outer margin on each side, in cells. */
const MARGIN = 2;
/** Cells kept between the two halves. */
const MIN_GAP = 2;
/** Floor for a shortened name before the whole right side is dropped. */
const MIN_NAME = 4;

const w = (s: string): number => [...s].length;
const total = (segs: readonly LocationSegment[]): number => segs.reduce((n, s) => n + w(s.text), 0);
const join = (segs: readonly LocationSegment[]): string => segs.map((s) => s.text).join('');

const chipText = (status: string): string => `[${status.toUpperCase().replace(/_/g, ' ')}]`;

const buildLeft = (
  input: LocationInput,
  parts: readonly string[],
  clippedFront: boolean,
  subtitle: string | undefined
): LocationSegment[] => {
  const segs: LocationSegment[] = [{ text: `${glyphs.badge} `, tone: 'badge' }];
  if (clippedFront) segs.push({ text: `${glyphs.clipEllipsis} ${glyphs.selectMarker} `, tone: 'dim' });
  parts.forEach((part, i) => {
    if (i > 0) segs.push({ text: ` ${glyphs.selectMarker} `, tone: 'dim' });
    // The section root is the anchor (bold); deeper crumbs read as a trail.
    const isSection = !clippedFront && i === 0 && part === input.section;
    segs.push({ text: part, tone: isSection ? 'section' : 'trail' });
  });
  if (subtitle !== undefined && subtitle.length > 0) {
    segs.push({ text: ` ${glyphs.emDash} ${subtitle}`, tone: 'subtitle' });
  }
  return segs;
};

interface RightSpec {
  readonly project: string | undefined;
  readonly sprint: string | undefined;
  readonly chip: string | undefined;
}

const buildRight = (wide: boolean, spec: RightSpec): LocationSegment[] => {
  const segs: LocationSegment[] = [];
  if (spec.project !== undefined) {
    if (wide) segs.push({ text: 'project ', tone: 'dim' });
    segs.push({ text: spec.project, tone: 'name' });
    if (spec.sprint !== undefined) {
      segs.push({ text: ` ${glyphs.selectMarker} `, tone: 'dim' });
      if (wide) segs.push({ text: 'sprint ', tone: 'dim' });
      segs.push({ text: spec.sprint, tone: 'name' });
      if (spec.chip !== undefined) segs.push({ text: ' ', tone: 'dim' }, { text: spec.chip, tone: 'chip' });
    }
  }
  if (wide) {
    if (segs.length > 0) segs.push({ text: '   ', tone: 'dim' });
    segs.push({ text: 'S', tone: 'key' }, { text: ' switch', tone: 'dim' });
  }
  return segs;
};

/**
 * Left candidates in drop order: full → no subtitle → trail clipped from its start, one part at a time, until only
 * the last part remains.
 */
const leftCandidates = (input: LocationInput): LocationSegment[][] => {
  const parts = [input.section, ...input.trail];
  const out: LocationSegment[][] = [];
  if (input.subtitle !== undefined && input.subtitle.length > 0)
    out.push(buildLeft(input, parts, false, input.subtitle));
  out.push(buildLeft(input, parts, false, undefined));
  for (let drop = 1; drop < parts.length; drop++) out.push(buildLeft(input, parts.slice(drop), true, undefined));
  return out;
};

/** Fitting arithmetic shared by every step: the row's budget, the caller-owned node, the gap. */
interface Fitter {
  readonly available: number;
  readonly extra: number;
  readonly rightFor: (spec: RightSpec) => LocationSegment[];
  readonly fits: (left: readonly LocationSegment[], right: readonly LocationSegment[]) => boolean;
  readonly done: (left: LocationSegment[], right: LocationSegment[]) => LocationLayout;
}

const createFitter = (input: LocationInput, chipFull: string | undefined): Fitter => {
  const available = input.columns - 2 * MARGIN;
  const extra = input.leftExtraWidth !== undefined && input.leftExtraWidth > 0 ? input.leftExtraWidth + 1 : 0;
  const hasRight = input.project !== undefined || input.wide;
  return {
    available,
    extra,
    rightFor: (spec) => (hasRight ? buildRight(input.wide, spec) : []),
    fits: (left, right) => total(left) + extra + (right.length > 0 ? MIN_GAP : 0) + total(right) <= available,
    done: (left, right) => ({
      left,
      right,
      leftText: join(left),
      rightText: join(right),
      chip: right.some((s) => s.tone === 'chip') ? chipFull : undefined,
    }),
  };
};

/** The name to shorten next: the longer one, never below {@link MIN_NAME}; `undefined` when both are at the floor. */
const shortenNext = (spec: RightSpec): RightSpec | undefined => {
  const pw = spec.project === undefined ? 0 : w(spec.project);
  const sw = spec.sprint === undefined ? 0 : w(spec.sprint);
  if (spec.sprint !== undefined && sw >= pw && sw > MIN_NAME) {
    return { ...spec, sprint: clipWithEllipsis(spec.sprint, sw - 1) };
  }
  if (spec.project !== undefined && pw > MIN_NAME) {
    return { ...spec, project: clipWithEllipsis(spec.project, pw - 1) };
  }
  return undefined;
};

export const layoutLocation = (input: LocationInput): LocationLayout => {
  const chipFull = input.status !== undefined ? chipText(input.status) : undefined;
  const fit = createFitter(input, chipFull);
  const lefts = leftCandidates(input);
  const tightestLeft = lefts[lefts.length - 1] as LocationSegment[];
  const fullSpec: RightSpec = { project: input.project, sprint: input.sprint, chip: chipFull };
  const noChipSpec: RightSpec = { ...fullSpec, chip: undefined };

  // Steps 1–2: give up subtitle / trail while the right side stays intact; step 3: drop the status
  // chip, keeping the most-trimmed left.
  const hasSubtitle = input.subtitle !== undefined && input.subtitle.length > 0;
  const unclipped = hasSubtitle ? 2 : 1;
  const noSubtitleLeft = lefts[unclipped - 1] as LocationSegment[];
  const none: RightSpec = { project: undefined, sprint: undefined, chip: undefined };
  const drilledIn = !input.wide && (input.trail.length > 0 || (input.leftExtraWidth ?? 0) > 0);
  const toFull = (left: LocationSegment[]): readonly [LocationSegment[], RightSpec] => [left, fullSpec];
  const attempts: ReadonlyArray<readonly [LocationSegment[], RightSpec]> = [
    ...lefts.slice(0, unclipped).map(toFull),
    ...(drilledIn
      ? [
          [noSubtitleLeft, noChipSpec] as const,
          [noSubtitleLeft, { ...none, project: input.project }] as const,
          [noSubtitleLeft, none] as const,
        ]
      : []),
    ...lefts.slice(unclipped).map(toFull),
    ...(chipFull !== undefined ? [[tightestLeft, noChipSpec] as const] : []),
  ];
  for (const [left, spec] of attempts) {
    const right = fit.rightFor(spec);
    if (fit.fits(left, right)) return fit.done(left, right);
  }

  // Step 4: shorten the names, longest first.
  for (let spec = shortenNext(noChipSpec); spec !== undefined; spec = shortenNext(spec)) {
    const right = fit.rightFor(spec);
    if (fit.fits(tightestLeft, right)) return fit.done(tightestLeft, right);
  }
  // Last resort: the right side gives way entirely; the left keeps what fits.
  return fit.done(clipLeft(tightestLeft, fit.available - fit.extra), []);
};

/** Whole-glyph clip of the left segments to `max` cells (last resort only). */
const clipLeft = (segs: readonly LocationSegment[], max: number): LocationSegment[] => {
  const out: LocationSegment[] = [];
  let left = max;
  for (const seg of segs) {
    if (left <= 0) break;
    const cps = [...seg.text];
    if (cps.length <= left) {
      out.push(seg);
      left -= cps.length;
    } else {
      out.push({ text: clipWithEllipsis(seg.text, left), tone: seg.tone });
      left = 0;
    }
  }
  return out;
};
