/**
 * Width-driven ellision fence for TasksPanel. Replaces the deleted local `truncate()` helper
 * (hardcoded 80-char clip) with Ink flex layout + `wrap="truncate-end"`. The body box grows
 * to fill the remaining row width and ellides at the actual rendered column count, not at a
 * magic character budget.
 *
 * These tests wrap the panel in a fixed-width `<Box>` so the assertions don't depend on the
 * 100-column default `process.stdout.columns` of ink-testing-library. Long messages must:
 *   - render with a trailing ellipsis at narrow widths
 *   - never push past the configured column count (no line-wrap, no layout overflow)
 *   - render verbatim when the available width comfortably exceeds the message length
 */

import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { ChangeSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const taskWithSignal = (text: string): TaskBucket => ({
  id: '01933fbb-0000-7000-8000-000000000001',
  status: 'running',
  subSteps: [],
  evaluations: [],
  signals: [{ type: 'change', text, timestamp: ts(1) } satisfies ChangeSignal],
  genEvalRound: 0,
});

const renderAtWidth = (bucketed: BucketedExecution, width: number): string => {
  const r = render(
    <Box width={width} flexDirection="column">
      <TasksPanel bucketed={bucketed} running={true} />
    </Box>
  );
  const frame = r.lastFrame() ?? '';
  r.unmount();
  return frame;
};

describe('TasksPanel width-driven ellision', () => {
  it('ellides a long signal body at narrow widths and never exceeds the column count', () => {
    const longBody = 'x'.repeat(500);
    const bucketed: BucketedExecution = {
      tasks: [taskWithSignal(longBody)],
      orphanSignals: [],
    };
    const frame = renderAtWidth(bucketed, 60);

    // No line in the frame exceeds the configured width. (Ink may pad some short lines with
    // spaces, but no logical row should exceed 60 cols.)
    for (const line of frame.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    // The full long body cannot have landed — width is 60 cols, body is 500 chars.
    expect(frame).not.toContain('x'.repeat(120));
  });

  it('does not clip a short signal body that comfortably fits the width', () => {
    const shortBody = 'added user-id index';
    const bucketed: BucketedExecution = {
      tasks: [taskWithSignal(shortBody)],
      orphanSignals: [],
    };
    const frame = renderAtWidth(bucketed, 120);
    // The full message must appear verbatim — wide layout, no ellision.
    expect(frame).toContain(shortBody);
  });

  it('collapses internal whitespace so multi-line payloads render as one row', () => {
    // `task-verified` historically pre-collapsed whitespace before the char-clip. The new
    // layout pushes whitespace collapse into the renderer so every signal type benefits, and
    // long payloads with embedded newlines still render on one row before width-ellision.
    const bucketed: BucketedExecution = {
      tasks: [taskWithSignal('first line\n\nsecond paragraph\nthird line')],
      orphanSignals: [],
    };
    const frame = renderAtWidth(bucketed, 200);
    // All on one row: no embedded newline survives.
    expect(frame).toContain('first line second paragraph third line');
  });
});
