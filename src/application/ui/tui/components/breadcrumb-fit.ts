/** Pure width budgeting for the breadcrumb's right side: names shrink first, then the status chip goes. */

import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';

const MIN_NAME = 6;

const cells = (s: string): number => [...s].length;

export const clipName = (name: string, max: number): string =>
  cells(name) <= max ? name : `${[...name].slice(0, Math.max(1, max - 1)).join('')}${glyphs.clipEllipsis}`;

export interface FitInput {
  /** Cells the right side may occupy. */
  readonly budget: number;
  readonly project: string;
  readonly sprint: string | undefined;
  /** Rendered width of the status chip incl. its leading gutter; 0 when there is none. */
  readonly chipCells: number;
}

export interface FitResult {
  readonly project: string;
  readonly sprint: string | undefined;
  readonly showChip: boolean;
}

// `project: ` + ` [P]`, and ` · sprint: ` + ` [S]` — the labels and hints stay whole.
const PROJECT_FIXED = 'project: '.length + ' [P]'.length;
const SPRINT_FIXED = ` ${glyphs.bullet} sprint: `.length + ' [S]'.length;

/** Water-fill: trim the longer name first so both stay recognisable. */
const shrink = (names: readonly number[], room: number): number[] => {
  const out = [...names];
  let over = out.reduce((a, b) => a + b, 0) - room;
  while (over > 0) {
    const i = out.indexOf(Math.max(...out));
    if ((out[i] ?? 0) <= MIN_NAME) break;
    out[i] = (out[i] ?? 0) - 1;
    over -= 1;
  }
  return out;
};

export const fitBreadcrumbRight = ({ budget, project, sprint, chipCells }: FitInput): FitResult => {
  const lengths = [cells(project), ...(sprint !== undefined ? [cells(sprint)] : [])];
  const fixed = PROJECT_FIXED + (sprint !== undefined ? SPRINT_FIXED : 0);
  const attempt = (withChip: boolean): FitResult | undefined => {
    const room = budget - fixed - (withChip ? chipCells : 0);
    const fitted = shrink(lengths, room);
    if (fitted.reduce((a, b) => a + b, 0) > room) return undefined;
    return {
      project: clipName(project, fitted[0] ?? lengths[0] ?? 0),
      sprint: sprint !== undefined ? clipName(sprint, fitted[1] ?? 0) : undefined,
      showChip: withChip && chipCells > 0,
    };
  };
  if (chipCells > 0) {
    const withChip = attempt(true);
    if (withChip !== undefined) return withChip;
  }
  // Even at the minimum widths nothing fits: clip as hard as the budget allows (the Text truncates the rest).
  return (
    attempt(false) ?? {
      project: clipName(project, MIN_NAME),
      sprint: sprint !== undefined ? clipName(sprint, MIN_NAME) : undefined,
      showChip: false,
    }
  );
};

/** Cells the `[STATUS]` chip takes incl. its leading gutter; 0 when there is no status to show. */
export const chipCellsFor = (status: string | undefined): number =>
  status === undefined ? 0 : spacing.gutter + status.length + 2;
