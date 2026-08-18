/**
 * Tasks panel — the `v` chord that opens the evaluation overlay.
 *
 * Contract pinned here:
 *  - fires for the FOCUSED card (not the active one — an operator reads a verdict about a card
 *    they deliberately moved the cursor onto, frequently a finished one further up the list);
 *  - is INERT on a card with no recorded verdict, rather than opening an empty overlay;
 *  - is inert when the host wired no handler (isolated renders, hosts without the overlay);
 *  - does not disturb the sibling chords it was inserted next to (`e` criteria, ↵ expand).
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TaskEvaluation } from '@src/application/ui/tui/components/tasks-panel-internals/evaluation-row.tsx';
import { ENTER, tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const bucketed = (): BucketedExecution => ({
  tasks: [
    { id: 'task-done', status: 'completed', subSteps: [], evaluations: [], signals: [], genEvalRound: 1 },
    { id: 'task-live', status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 1 },
  ],
  orphanSignals: [],
});

const evaluations = (entries: ReadonlyArray<readonly [string, TaskEvaluation]>): ReadonlyMap<string, TaskEvaluation> =>
  new Map(entries);

const renderPanel = (
  onOpenEvaluation: ((taskId: string) => void) | undefined,
  taskEvaluationById: ReadonlyMap<string, TaskEvaluation>
): ReturnType<typeof render> =>
  render(
    <TasksPanel
      bucketed={bucketed()}
      running={true}
      inputActive={true}
      taskEvaluationById={taskEvaluationById}
      {...(onOpenEvaluation !== undefined ? { onOpenEvaluation } : {})}
    />
  );

describe("TasksPanel — `v` opens the focused card's evaluation", () => {
  it('calls onOpenEvaluation with the focused card id', async () => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    // The cursor defaults to the ACTIVE card (`task-live`, the first non-completed one).
    const r = renderPanel(
      onOpenEvaluation,
      evaluations([
        ['task-done', { status: 'passed', attemptN: 1, file: 'rounds/1/evaluator/evaluation.md' }],
        ['task-live', { status: 'failed', attemptN: 2, file: 'rounds/3/evaluator/evaluation.md' }],
      ])
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    r.stdin.write('v');
    await waitForPredicate(() => onOpenEvaluation.mock.calls.length === 1);
    expect(onOpenEvaluation).toHaveBeenCalledWith('task-live');
    r.unmount();
  });

  it('targets the FOCUSED card after the cursor moves, not the active one', async () => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    const r = renderPanel(
      onOpenEvaluation,
      evaluations([
        ['task-done', { status: 'passed', attemptN: 1, file: 'rounds/1/evaluator/evaluation.md' }],
        ['task-live', { status: 'failed', attemptN: 2, file: 'rounds/3/evaluator/evaluation.md' }],
      ])
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Move the card cursor up onto the completed card, then read its verdict.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('v');
    await waitForPredicate(() => onOpenEvaluation.mock.calls.length === 1);
    expect(onOpenEvaluation).toHaveBeenCalledWith('task-done');
    r.unmount();
  });

  it('is inert on a card with no recorded verdict', async () => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    // Only the completed card has a verdict; focus starts on the active one, which has none.
    const r = renderPanel(
      onOpenEvaluation,
      evaluations([['task-done', { status: 'passed', attemptN: 1, file: 'rounds/1/evaluator/evaluation.md' }]])
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    r.stdin.write('v');
    await tick(50);
    expect(onOpenEvaluation).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is inert when the host wires no handler', async () => {
    const r = renderPanel(
      undefined,
      evaluations([['task-live', { status: 'failed', attemptN: 2, file: 'rounds/3/evaluator/evaluation.md' }]])
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));
    const before = r.lastFrame() ?? '';
    r.stdin.write('v');
    await tick(50);
    expect(r.lastFrame() ?? '').toBe(before);
    r.unmount();
  });

  it('leaves the sibling chords it was inserted next to alone', async () => {
    const onOpenEvaluation = vi.fn<(taskId: string) => void>();
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        taskCriteriaById={new Map([['task-live', ['[AC-1] manual — the thing works']]])}
        taskEvaluationById={evaluations([
          ['task-live', { status: 'failed', attemptN: 2, file: 'rounds/3/evaluator/evaluation.md' }],
        ])}
        onOpenEvaluation={onOpenEvaluation}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('AC-1'));

    // `e` still toggles the criteria block and must NOT open the overlay.
    r.stdin.write('e');
    await tick(40);
    expect(onOpenEvaluation).not.toHaveBeenCalled();

    // Enter still collapses / expands the focused card.
    r.stdin.write(ENTER);
    await tick(40);
    expect(onOpenEvaluation).not.toHaveBeenCalled();
    r.unmount();
  });
});
