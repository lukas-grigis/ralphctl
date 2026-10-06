/**
 * One-line main-step strip for the header card: `steps  ■ Prepare  →  ◆ Run tasks 0/1  →  ◇ Finish`
 * with the position (or the failure locator) right-aligned. It is ONE truncating `<Text>` — never
 * sibling Boxes — so it can't wrap. `fitStepStrip` degrades it in three steps as the width shrinks:
 * full labels, then glyph-only for every step but the active one, then the active step alone.
 */

import React from 'react';
import { Text } from 'ink';
import { glyphs, inkColors } from '@src/application/ui/tui/theme/tokens.ts';
import { stepMark } from '@src/application/ui/tui/components/flow-steps-tree.tsx';
import type { FlowProgress, StepView } from '@src/application/ui/tui/runtime/flow-progress.ts';

export interface StripSegment {
  readonly text: string;
  readonly color?: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
}

export interface StepStrip {
  readonly segments: readonly StripSegment[];
  /** Which degradation step produced this layout. */
  readonly level: 1 | 2 | 3;
}

type StripInput = Pick<FlowProgress, 'spine' | 'activeSpineIndex' | 'failure'>;

const ARROW = `  ${glyphs.arrowRight}  `;
const MIN_GAP = 2;

const lengthOf = (segments: readonly StripSegment[]): number => segments.reduce((n, s) => n + s.text.length, 0);

const stepLabel = (view: StepView): string =>
  view.progress !== undefined
    ? `${view.label} ${String(view.progress.done)}/${String(view.progress.total)}`
    : view.label;

const stepSegment = (view: StepView, withLabel: boolean): StripSegment => {
  const mark = stepMark(view.status, false);
  const glyph = mark.glyph ?? glyphs.phaseActive;
  return {
    text: withLabel ? `${glyph} ${stepLabel(view)}` : glyph,
    color: mark.color,
    ...(view.status === 'pending' ? { dim: true } : {}),
    ...(view.status === 'running' || view.status === 'waiting' ? { bold: true } : {}),
  };
};

const focusIndex = (input: StripInput): number => {
  if (input.activeSpineIndex !== undefined) return input.activeSpineIndex;
  const lastDone = input.spine.map((v) => v.status).lastIndexOf('completed');
  return lastDone >= 0 ? lastDone : 0;
};

const rightText = (input: StripInput, index: number): string => {
  if (input.failure !== undefined) {
    const where = input.failure.workItemLabel !== undefined ? ` ${glyphs.bullet} ${input.failure.workItemLabel}` : '';
    return `failed at ${input.failure.label}${where}`;
  }
  return `step ${String(index + 1)}/${String(input.spine.length)}`;
};

const joined = (views: readonly StepView[], labelled: (i: number) => boolean): StripSegment[] =>
  views.flatMap((v, i): StripSegment[] => [
    ...(i > 0 ? [{ text: ARROW, dim: true }] : []),
    stepSegment(v, labelled(i)),
  ]);

/** Pick the richest layout that fits `width` columns. Pure. */
export const fitStepStrip = (input: StripInput, width: number): StepStrip => {
  const lead: StripSegment = { text: 'steps  ', dim: true };
  const index = focusIndex(input);
  const right = rightText(input, index);

  const fits = (steps: readonly StripSegment[]): StripSegment[] | undefined => {
    const left = [lead, ...steps];
    const pad = width - lengthOf(left) - right.length;
    if (pad < MIN_GAP) return undefined;
    return [
      ...left,
      { text: ' '.repeat(pad) },
      input.failure !== undefined ? { text: right, color: inkColors.error } : { text: right, dim: true },
    ];
  };

  const full = fits(joined(input.spine, () => true));
  if (full !== undefined) return { segments: full, level: 1 };
  const glyphOnly = fits(joined(input.spine, (i) => i === index));
  if (glyphOnly !== undefined) return { segments: glyphOnly, level: 2 };

  const active = input.spine[index];
  const position = `${String(index + 1)}/${String(input.spine.length)}`;
  const tail: StripSegment = { text: ` ${glyphs.bullet} ${position}`, dim: true };
  return { segments: [lead, ...(active !== undefined ? [stepSegment(active, true)] : []), tail], level: 3 };
};

/** The strip's plain text, for tests and width checks. */
export const stripText = (strip: StepStrip): string => strip.segments.map((s) => s.text).join('');

export interface FlowProgressStripProps {
  readonly progress: FlowProgress | undefined;
  /** Columns the line may use (the card's inner width). */
  readonly width: number;
}

/** Whitespace stays outside the styled `<Text>`: Ink collapses edge spaces inside one. */
const SegmentText = ({ segment }: { readonly segment: StripSegment }): React.JSX.Element => {
  const [, lead = '', core = '', trail = ''] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text) ?? [];
  if (core.length === 0) return <>{segment.text}</>;
  return (
    <>
      {lead}
      <Text
        {...(segment.color !== undefined ? { color: segment.color } : {})}
        dimColor={segment.dim === true}
        bold={segment.bold === true}
      >
        {core}
      </Text>
      {trail}
    </>
  );
};

export const FlowProgressStrip = ({ progress, width }: FlowProgressStripProps): React.JSX.Element | null => {
  if (progress === undefined || progress.spine.length === 0) return null;
  const strip = fitStepStrip(progress, width);
  return (
    <Text wrap="truncate-end">
      {strip.segments.map((s, i) => (
        <SegmentText key={`${String(i)}-${s.text}`} segment={s} />
      ))}
    </Text>
  );
};
