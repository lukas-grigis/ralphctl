/**
 * TasksPanel — collapsed-by-default task cards with j/k expansion.
 *
 * Layout rules:
 *   - The active (first non-completed) task auto-expands when it becomes active; the user
 *     can collapse it (Esc or Enter) like any other card.
 *   - All other tasks are collapsed by default to a one-line summary:
 *       <icon> <name> · <status> · <attempts>× · <lastCommitSha?>
 *   - j/k moves the card cursor when the focused card is collapsed; Enter/Space toggles
 *     expansion. When a card is expanded, j/k moves between its signal rows.
 *   - Esc collapses an expanded focused card.
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

  it('Esc on the active card collapses it (auto-expand is a seed, not a permanent lock)', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    // Cursor defaults to the active task. Active task is auto-expanded so its stream is visible.
    expect(r.lastFrame() ?? '').toContain('task-2 active change');
    r.stdin.write(ESC);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain('task-2 active change');
    r.unmount();
  });

  it('Enter on an expanded card (with no row anchor) collapses it', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    // Active task is auto-expanded; cursor is on it.
    expect(r.lastFrame() ?? '').toContain('task-2 active change');
    r.stdin.write(ENTER);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain('task-2 active change');
    r.unmount();
  });

  it('Enter on an expanded then collapsed card re-expands it (toggle)', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    r.stdin.write(ENTER);
    await tick(40);
    expect(r.lastFrame() ?? '').not.toContain('task-2 active change');
    r.stdin.write(ENTER);
    await tick(40);
    expect(r.lastFrame() ?? '').toContain('task-2 active change');
    r.unmount();
  });

  it('when the active task transitions to a new id, the new id auto-expands', async () => {
    const r = render(<TasksPanel bucketed={bucketed} running={true} inputActive={true} />);
    await tick(30);
    expect(r.lastFrame() ?? '').toContain('task-2 active change');

    // Simulate the run advancing: task-2 completes, task-3 is now the active one.
    const advanced: BucketedExecution = {
      tasks: [
        ...bucketed.tasks.map((t) => (t.id === 'task-2' ? { ...t, status: 'completed' as const } : t)),
        {
          id: 'task-3',
          status: 'running' as const,
          subSteps: [],
          evaluations: [],
          signals: [{ type: 'change' as const, text: 'task-3 active change', timestamp: ts(20) }],
          genEvalRound: 0,
        },
      ],
      orphanSignals: [],
    };
    r.rerender(<TasksPanel bucketed={advanced} running={true} inputActive={true} />);
    await tick(40);
    // New active task auto-expanded → its stream shows.
    expect(r.lastFrame() ?? '').toContain('task-3 active change');
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
