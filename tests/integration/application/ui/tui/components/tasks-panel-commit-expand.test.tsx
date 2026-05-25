/**
 * TasksPanel — commit-message row expansion.
 *
 * A `commit-message` signal carries `subject` + optional `body`. The TUI default is collapsed:
 * subject only. The body expands once a row cursor is anchored on the commit row and the user
 * presses Enter / Space — but on a fresh-mounted card with no row anchor yet, Enter toggles
 * card expansion (per the card-toggle UX), not the commit row. These tests exercise the
 * rendering and the disclosure-glyph contract; the keyboard-driven row-scope expansion path
 * needs an anchored row cursor and is exercised via panel-level integration once that anchor
 * key exists.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { CommitMessageSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const commit = (extras: Partial<CommitMessageSignal> = {}): CommitMessageSignal => ({
  type: 'commit-message',
  subject: 'feat(web-ui): add confetti to landing page',
  timestamp: ts(0),
  ...extras,
});

const bucketWithSignals = (signals: readonly HarnessSignal[]): BucketedExecution => ({
  tasks: [
    {
      id: 'task-1',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals,
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
});

describe('TasksPanel commit-message rendering', () => {
  it('renders only the subject in the default (collapsed) state', () => {
    const sig = commit({
      body: 'Adds a one-shot canvas-confetti burst on initial page mount.\nGated on prefers-reduced-motion.',
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('feat(web-ui): add confetti to landing page');
    // Body is hidden when collapsed.
    expect(frame).not.toContain('canvas-confetti burst');

    r.unmount();
  });

  it('renders the collapsed disclosure caret when a body is present', () => {
    const sig = commit({ body: 'Some body content.' });
    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('▸');
    r.unmount();
  });

  it('omits the disclosure caret when the row carries no body (degenerate case)', () => {
    // AI emitted only a subject — no body. The disclosure indicator is suppressed (it would
    // lie about expandability).
    const sig = commit({ subject: 'fix: typo' });
    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('fix: typo');
    expect(frame).not.toContain('▸');
    expect(frame).not.toContain('▾');
    r.unmount();
  });

  it('Enter on the active (auto-expanded) card collapses it rather than expanding the commit row', async () => {
    // New card-toggle semantics: Enter on an expanded focused card without a row anchor
    // collapses the card. Commit-body expansion requires anchoring a row cursor first.
    const sig = commit({ body: 'Adds a one-shot canvas-confetti burst on initial page mount.' });
    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    // Card is auto-expanded → subject visible.
    expect(r.lastFrame() ?? '').toContain('feat(web-ui): add confetti to landing page');
    r.stdin.write(ENTER);
    await tick(30);
    // After Enter the card is collapsed → subject hidden.
    expect(r.lastFrame() ?? '').not.toContain('feat(web-ui): add confetti to landing page');
    r.unmount();
  });

  it('long body wraps cleanly within the available column width (truncate-end)', () => {
    // Smoke test on the layout discipline of the commit row when a body is present. We render
    // the auto-expanded card (no key presses needed) and check the longest line stays inside
    // ink-testing-library's hardcoded 100-col stdout width.
    const longBody = 'x'.repeat(500);
    const sig = commit({ body: longBody });
    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';
    const ansiRe = /\[[0-9;]*m/g;
    const longest = frame
      .split('\n')
      .map((l) => l.replace(ansiRe, '').length)
      .reduce((m, n) => Math.max(m, n), 0);
    expect(longest).toBeLessThanOrEqual(100);
    r.unmount();
  });

  it('input is ignored when inputActive is false (card stays auto-expanded)', async () => {
    const sig = commit({ body: 'Some body content.' });
    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={false} />);
    expect(r.lastFrame() ?? '').toContain('feat(web-ui): add confetti to landing page');
    r.stdin.write(ENTER);
    await tick(30);
    // Enter is a no-op when inputActive is false — card stays expanded.
    expect(r.lastFrame() ?? '').toContain('feat(web-ui): add confetti to landing page');
    r.unmount();
  });
});
