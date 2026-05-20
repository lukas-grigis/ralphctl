/**
 * TasksPanel — commit-message row expansion.
 *
 * A `commit-message` signal carries `subject`, optional `body`, and (after the harness
 * re-emits it post-`assembleCommitMessage`) `fullMessage` — subject + body + `Closes #…`
 * trailer. The TUI default is collapsed: subject only. When the cursor focuses a commit row
 * and the user presses Enter or Space, the body + trailer expand under the signal label
 * column. Multiple rows can be expanded; expansion state persists across re-renders.
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

describe('TasksPanel commit-message expansion', () => {
  it('renders only the subject in the default (collapsed) state', () => {
    const sig = commit({
      body: 'Adds a one-shot canvas-confetti burst on initial page mount.\nGated on prefers-reduced-motion.',
      fullMessage:
        'feat(web-ui): add confetti to landing page\n\nAdds a one-shot canvas-confetti burst on initial page mount.\nGated on prefers-reduced-motion.\n\nCloses #42',
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('feat(web-ui): add confetti to landing page');
    // Body and trailer are hidden when collapsed.
    expect(frame).not.toContain('canvas-confetti burst');
    expect(frame).not.toContain('Closes #42');

    r.unmount();
  });

  it('expands body + Closes trailer when Enter is pressed on the focused commit row', async () => {
    const sig = commit({
      fullMessage:
        'feat(web-ui): add confetti to landing page\n\nAdds a one-shot canvas-confetti burst on initial page mount.\nGated on prefers-reduced-motion.\n\nCloses #42',
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    // The single commit row is the only focusable row in the panel — Enter on a fresh mount
    // anchors the cursor on the latest row and toggles its expansion in one keystroke.
    r.stdin.write(ENTER);
    await tick(30);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('canvas-confetti burst');
    expect(frame).toContain('prefers-reduced-motion');
    expect(frame).toContain('Closes #42');

    r.unmount();
  });

  it('Space toggles expansion (equivalent to Enter)', async () => {
    const sig = commit({
      fullMessage: 'feat(web-ui): add confetti to landing page\n\nBody line.\n\nCloses #42',
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    r.stdin.write(' ');
    await tick(30);
    expect(r.lastFrame() ?? '').toContain('Body line.');

    // Second Space collapses again.
    r.stdin.write(' ');
    await tick(30);
    expect(r.lastFrame() ?? '').not.toContain('Body line.');

    r.unmount();
  });

  it('does not expand when the row carries no body or fullMessage (degenerate case)', async () => {
    // AI emitted only a subject — no body, no harness-resolved fullMessage. The expansion is
    // a no-op rather than rendering a phantom empty block. The disclosure indicator is also
    // suppressed (it would lie about expandability).
    const sig = commit({ subject: 'fix: typo' });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    r.stdin.write(ENTER);
    await tick(30);
    const frame = r.lastFrame() ?? '';
    // Subject still rendered.
    expect(frame).toContain('fix: typo');
    // No disclosure carets — there is nothing to disclose.
    expect(frame).not.toContain('▸');
    expect(frame).not.toContain('▾');
    r.unmount();
  });

  it('expansion state persists across an unrelated re-render (panel-local state)', async () => {
    const sig = commit({
      fullMessage: 'feat(web-ui): add confetti to landing page\n\nBody line one.\n\nCloses #42',
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    r.stdin.write(ENTER);
    await tick(30);
    expect(r.lastFrame() ?? '').toContain('Body line one.');

    // Re-render with a new running flag value. Expansion lives in panel-local useState — it
    // must survive the prop change.
    r.rerender(<TasksPanel bucketed={bucketWithSignals([sig])} running={false} inputActive={true} />);
    await tick(10);
    expect(r.lastFrame() ?? '').toContain('Body line one.');

    r.unmount();
  });

  it('expansion handles multiple commits independently', async () => {
    const c1 = commit({
      subject: 'feat: first',
      fullMessage: 'feat: first\n\nFirst body.\n\nCloses #1',
      timestamp: ts(0),
    });
    const c2 = commit({
      subject: 'feat: second',
      fullMessage: 'feat: second\n\nSecond body.\n\nCloses #2',
      timestamp: ts(10),
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([c1, c2])} running={true} inputActive={true} />);

    // Cursor anchors on the most recent (second) row on first Enter; expand it.
    r.stdin.write(ENTER);
    await tick(30);
    let frame = r.lastFrame() ?? '';
    expect(frame).toContain('Second body.');
    expect(frame).not.toContain('First body.');

    // Move cursor up (k) and expand the first row too.
    r.stdin.write('k');
    await tick(30);
    r.stdin.write(ENTER);
    await tick(30);
    frame = r.lastFrame() ?? '';
    expect(frame).toContain('First body.');
    expect(frame).toContain('Second body.');

    r.unmount();
  });

  it('long body wraps cleanly within the available column width (truncate-end)', async () => {
    const longBody = 'x'.repeat(500);
    const sig = commit({
      fullMessage: `feat(web-ui): add confetti to landing page\n\n${longBody}\n\nCloses #42`,
    });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={true} />);
    r.stdin.write(ENTER);
    await tick(30);
    const frame = r.lastFrame() ?? '';

    const ansiRe = /\[[0-9;]*m/g;
    const longest = frame
      .split('\n')
      .map((l) => l.replace(ansiRe, '').length)
      .reduce((m, n) => Math.max(m, n), 0);
    // ink-testing-library hardcodes stdout.columns=100. The body's flexGrow + truncate-end
    // wrapper bounds every line to the budget; a 500-char body absent the wrapper would push
    // the layout past 100. Assert the hard cap.
    expect(longest).toBeLessThanOrEqual(100);
    r.unmount();
  });

  it('input is ignored when inputActive is false (cursor and expansion no-op)', async () => {
    const sig = commit({ fullMessage: 'feat: x\n\nHidden body.\n\nCloses #42' });

    const r = render(<TasksPanel bucketed={bucketWithSignals([sig])} running={true} inputActive={false} />);
    r.stdin.write(ENTER);
    await tick(30);
    const frame = r.lastFrame() ?? '';
    expect(frame).not.toContain('Hidden body.');
    r.unmount();
  });
});
