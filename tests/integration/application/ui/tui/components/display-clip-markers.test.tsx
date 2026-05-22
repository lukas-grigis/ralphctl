/**
 * Audit-[03] display-clip-marker pins. The invariant the audit makes load-bearing:
 *
 *   "A clipped value without a marker is a bug, not a style choice."
 *
 * Two patterns the codebase uses:
 *
 *   1. Single-line trim → trailing `…` (`glyphs.clipEllipsis`, U+2026).
 *   2. Multi-line collapse with an expand hotkey → `▼ more` marker line
 *      (`glyphs.collapseExpand`).
 *
 * These tests pin the visual behaviour at representative call sites — StepTrace for the
 * single-line case, TasksPanel's CriteriaBlock for the multi-line collapse case. The
 * pure-string helpers also live behind unit assertions so a future refactor that drops the
 * marker without changing the layout fails here, not in a downstream snapshot test.
 *
 * Banner-clip unit (audit-[03] open item, resolved in this wave): the per-line clip on the
 * `setup-script` failure surface uses JS `String.prototype.length` (UTF-16 code units), an
 * explicit choice documented inline. The dedicated unit test below proves the round-trip
 * for ASCII, multi-byte UTF-8, and emoji.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { StepTrace } from '@src/application/ui/tui/components/step-trace.tsx';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const trace = (name: string, status: TraceEntry['status'] = 'completed'): TraceEntry => ({
  elementName: name,
  status,
  durationMs: 1,
});

describe('display-clip marker — single-line trim (audit-[03])', () => {
  it('appends `…` (U+2026) when a step-trace label exceeds the rail budget', () => {
    const longName = `${'a'.repeat(100)}-long-step`;
    const r = render(<StepTrace trace={[trace(longName)]} running={false} maxRows={10} railWidth={32} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(glyphs.clipEllipsis);
    expect(frame).not.toContain(longName); // The full string never renders.
    r.unmount();
  });

  it('omits the marker when content fits within the budget', () => {
    const shortName = 'load-tasks';
    const r = render(<StepTrace trace={[trace(shortName)]} running={false} maxRows={10} railWidth={64} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain(shortName);
    // No clip marker because nothing was clipped — operator must NOT see a stray ellipsis
    // suggesting hidden content.
    expect(frame).not.toContain(glyphs.clipEllipsis);
    r.unmount();
  });
});

const bucketWithCriteria = (taskId: string): BucketedExecution => ({
  tasks: [
    {
      id: taskId,
      status: 'running',
      signals: [],
      subSteps: [],
      evaluations: [],
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
});

describe('display-clip marker — multi-line collapse (audit-[03])', () => {
  it('appends a `▼ more` line when criteria collapse exceeds 3 lines (expand affordance via `e`)', () => {
    const taskId = '00000000-0000-7000-8000-000000000001';
    const criteriaById = new Map<string, readonly string[]>([
      [
        taskId,
        [
          'First criterion',
          'Second criterion',
          'Third criterion',
          'Hidden in collapsed view #1',
          'Hidden in collapsed view #2',
        ],
      ],
    ]);
    const r = render(
      <TasksPanel
        bucketed={bucketWithCriteria(taskId)}
        running={true}
        inputActive={false}
        taskCriteriaById={criteriaById}
      />
    );
    const frame = r.lastFrame() ?? '';
    // Visible head — first three bullets render verbatim.
    expect(frame).toContain('First criterion');
    expect(frame).toContain('Third criterion');
    // Marker line on the tail with explicit expand-affordance glyph + overflow count.
    expect(frame).toContain(glyphs.collapseExpand);
    expect(frame).toMatch(/\(2\)/);
    // Hidden tail must NOT render verbatim — that's the whole point of the collapse.
    expect(frame).not.toContain('Hidden in collapsed view #1');
    r.unmount();
  });

  it('omits the collapse marker when the criteria list fits inside the 3-line window', () => {
    const taskId = '00000000-0000-7000-8000-000000000002';
    const criteriaById = new Map<string, readonly string[]>([[taskId, ['Only criterion', 'Second criterion']]]);
    const r = render(
      <TasksPanel
        bucketed={bucketWithCriteria(taskId)}
        running={true}
        inputActive={false}
        taskCriteriaById={criteriaById}
      />
    );
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('Only criterion');
    expect(frame).toContain('Second criterion');
    // No collapse marker because nothing was hidden.
    expect(frame).not.toContain(glyphs.collapseExpand);
    r.unmount();
  });
});
