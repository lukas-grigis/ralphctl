/**
 * NO_COLOR fallback for the Tasks panel — when `NO_COLOR=1` is set, the per-kind colour
 * encoding on the signal label is no longer scannable. The shape backup prefixes the label
 * with a glyph (`+` change, `~` learning, `■` commit, `△` blocked, …) so each kind still reads
 * distinctly without colour.
 *
 * Snapshot-style assertions: render a bucketed fixture with one signal per kind we expect to
 * carry a glyph, set `NO_COLOR=1` for the test duration, and pin the rendered glyphs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type {
  ChangeSignal,
  CommitMessageSignal,
  DecisionSignal,
  HarnessSignal,
  LearningSignal,
  NoteSignal,
  TaskBlockedSignal,
  TaskVerifiedSignal,
} from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, n)).toISOString() as IsoTimestamp;

const change: ChangeSignal = { type: 'change', text: 'added confetti', timestamp: ts(1) };
const learning: LearningSignal = { type: 'learning', text: 'useLocation side-effect', timestamp: ts(2) };
const decision: DecisionSignal = { type: 'decision', text: 'split fetcher', timestamp: ts(3) };
const verified: TaskVerifiedSignal = { type: 'task-verified', output: 'green', timestamp: ts(4) };
const blocked: TaskBlockedSignal = { type: 'task-blocked', reason: 'missing dep', timestamp: ts(5) };
const note: NoteSignal = { type: 'note', text: 'follow up later', timestamp: ts(6) };
const commit: CommitMessageSignal = {
  type: 'commit-message',
  subject: 'feat: confetti',
  timestamp: ts(7),
};

const fixture: BucketedExecution = {
  tasks: [
    {
      id: '01933fbb-0000-7000-8000-000000000001',
      status: 'running',
      subSteps: [],
      evaluations: [],
      genEvalRound: 0,
      signals: [change, learning, decision, verified, blocked, note, commit] as readonly HarnessSignal[],
    },
  ],
  orphanSignals: [],
};

describe('TasksPanel NO_COLOR shape backups', () => {
  const original = process.env['NO_COLOR'];
  beforeEach(() => {
    process.env['NO_COLOR'] = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = original;
  });

  it('renders shape glyphs before each label when NO_COLOR is set', () => {
    const { lastFrame } = render(<TasksPanel bucketed={fixture} running={false} />);
    const frame = lastFrame() ?? '';
    // Each kind's glyph appears at least once. The label text stays present too so a reader
    // who can't see glyphs can still parse the row.
    expect(frame).toMatch(/\+\s+change\b/);
    expect(frame).toMatch(/~\s+learning\b/);
    expect(frame).toMatch(/◇\s+decision\b/);
    expect(frame).toMatch(/★\s+verified\b/);
    expect(frame).toMatch(/△\s+blocked\b/);
    expect(frame).toMatch(/•\s+note\b/);
    // The commit row goes through `CommitSignalLine`, not the default `SignalLine`. Its row
    // already carries its own disclosure-marker discipline (▸/▾) so we don't double-prefix.
    expect(frame).toContain('commit');
  });
});
