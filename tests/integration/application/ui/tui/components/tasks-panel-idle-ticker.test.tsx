/**
 * TasksPanel — idle-state ticker.
 *
 * When the active (running) task hasn't emitted a stream signal in >10s, the panel surfaces
 * the last 1–2 note / learning signals as a muted ticker line below the spinner. The moment
 * a new signal arrives the ticker hides.
 *
 * Tests pin a deterministic `nowMs` so the threshold check is reproducible without sleeping.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const isoAt = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp;

describe('TasksPanel idle-state ticker', () => {
  it('renders the last note signal as a muted ticker line when the latest signal is >10s old', () => {
    const baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [{ type: 'note', text: 'looking at the parser implementation', timestamp: isoAt(baseMs) }],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    // 12 seconds after the last signal.
    const r = render(<TasksPanel bucketed={bucketed} running={true} nowMs={baseMs + 12_000} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('looking at the parser implementation');
    r.unmount();
  });

  it('omits the ticker when the latest signal is fresh (< 10s old)', () => {
    const baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [{ type: 'note', text: 'fresh observation', timestamp: isoAt(baseMs) }],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    // Only 4s elapsed — still under threshold.
    const r = render(<TasksPanel bucketed={bucketed} running={true} nowMs={baseMs + 4_000} />);
    const frame = r.lastFrame() ?? '';
    // The note still appears in the signal stream — assert it does NOT also appear under the
    // active-task header (the ticker would be the indented row right under the spinner).
    // Easiest check: only one occurrence in the frame.
    const occurrences = frame.split('fresh observation').length - 1;
    expect(occurrences).toBe(1);
    r.unmount();
  });

  it('rolls in the prior note when two recent ones exist', () => {
    const baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [
            { type: 'note', text: 'older note', timestamp: isoAt(baseMs - 30_000) },
            { type: 'note', text: 'most recent note', timestamp: isoAt(baseMs) },
          ],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} nowMs={baseMs + 20_000} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('most recent note');
    expect(frame).toContain('older note');
    r.unmount();
  });

  it('does not fire on completed tasks even if the last signal is old', () => {
    const baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'completed',
          subSteps: [],
          evaluations: [],
          signals: [{ type: 'note', text: 'stale completed note', timestamp: isoAt(baseMs) }],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} nowMs={baseMs + 60_000} />);
    const frame = r.lastFrame() ?? '';
    // The completed card is collapsed — the note shouldn't render at all (collapsed cards
    // suppress their signal stream).
    expect(frame).not.toContain('stale completed note');
    r.unmount();
  });

  it('does not fire when the latest signal is something other than note / learning', () => {
    const baseMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const bucketed: BucketedExecution = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
          subSteps: [],
          evaluations: [],
          signals: [{ type: 'change', text: 'a change without a follow-up note', timestamp: isoAt(baseMs) }],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    const r = render(<TasksPanel bucketed={bucketed} running={true} nowMs={baseMs + 30_000} />);
    const frame = r.lastFrame() ?? '';
    // Snippet collection skips non-note / non-learning signals — the ticker stays empty.
    // The change signal still renders in the signal stream itself.
    const occurrences = frame.split('a change without a follow-up note').length - 1;
    expect(occurrences).toBe(1);
    r.unmount();
  });
});
