/**
 * TasksPanel — collapsed-by-default task cards with j/k expansion.
 *
 * Layout rules:
 *   - The active (first non-completed) task is always auto-expanded.
 *   - All other tasks are collapsed by default to a one-line summary:
 *       <icon> <name> · <status> · <attempts>× · <lastCommitSha?>
 *   - j/k moves the card cursor when the focused card is collapsed; Enter/Space expands.
 *   - When a card is expanded, j/k moves between its signal rows (legacy active-task behaviour).
 *   - Esc collapses a manually-expanded card; the active task is exempt (it would hide the
 *     live stream).
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() as IsoTimestamp;

const bucketed: BucketedExecution = {
  tasks: [
    {
      id: 'task-1',
      status: 'completed',
      subSteps: [],
      evaluations: [],
      signals: [
        { type: 'change', text: 'task-1 first change', timestamp: ts(1) },
        { type: 'change', text: 'task-1 second change', timestamp: ts(2) },
      ],
      genEvalRound: 0,
    },
    {
      id: 'task-2',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [{ type: 'change', text: 'task-2 active change', timestamp: ts(10) }],
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
};

describe('TasksPanel card collapse / expand', () => {
  it('renders completed tasks as a one-line collapsed summary by default', () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} />);
    const frame = r.lastFrame() ?? '';

    // Completed task hides its signal stream; the active running task shows it.
    expect(frame).not.toContain('task-1 first change');
    expect(frame).not.toContain('task-1 second change');
    expect(frame).toContain('task-2 active change');

    r.unmount();
  });

  it('expands a focused collapsed card on Enter', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    // Default cursor anchors on the active task (task-2). Move up to focus task-1 (collapsed).
    r.stdin.write('k');
    await tick(30);
    r.stdin.write(ENTER);
    await tick(30);

    const frame = r.lastFrame() ?? '';
    expect(frame).toContain('task-1 second change');
    r.unmount();
  });

  it('Esc collapses a manually-expanded card', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    r.stdin.write('k');
    await tick(30);
    r.stdin.write(ENTER);
    await tick(30);
    expect(r.lastFrame() ?? '').toContain('task-1 second change');

    r.stdin.write(ESC);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain('task-1 second change');
    r.unmount();
  });

  it('Esc on the active card is a no-op — the live stream stays visible', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    // Cursor defaults to the active task — pressing Esc must not collapse it.
    r.stdin.write(ESC);
    await tick(40);
    expect(r.lastFrame() ?? '').toContain('task-2 active change');
    r.unmount();
  });

  it('shows a focus caret on the cursored card', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    r.stdin.write('k');
    await tick(30);
    const frame = r.lastFrame() ?? '';
    // The cursor caret should appear somewhere in the frame; non-cursored card doesn't carry one
    // by definition. A loose smoke check is enough — exact column count varies with terminal width.
    expect(frame).toContain('›');
    r.unmount();
  });
});
