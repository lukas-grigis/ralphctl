/**
 * TasksPanel — the `u` chord that revives the FOCUSED card's stuck task, and the `e` chord now
 * anchored on the FOCUSED card (with the active task only as a fallback) instead of exclusively
 * the active task — which used to go dead the instant a run settled (no active task) even while
 * the card cursor sat right on a blocked card.
 *
 * Lives under `tests/integration/.../tui/` with the other nineteen `tasks-panel-*` render tests:
 * that path is the `tui` vitest project, which runs `fileParallelism: false` precisely because
 * sequential keystroke flows over Ink reconciliation are sensitive to fork contention. Written
 * under `tests/unit/` it ran in the `default` project at full parallelism and went red on the
 * v0.22.0 release-candidate gate.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Result } from '@src/domain/result.ts';
import { TasksPanelHost } from '@src/application/ui/tui/views/execute-view-internals/tasks-panel-host.tsx';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { stashRunner } from '@tests/fixtures/stash-runner.ts';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import { ENTER, tick, UP } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const bucketed = (): BucketedExecution => ({
  tasks: [
    { id: 'task-blocked', status: 'blocked', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
    { id: 'task-live', status: 'running', subSteps: [], evaluations: [], signals: [], genEvalRound: 1 },
  ],
  orphanSignals: [],
});

/**
 * Collapse every braille spinner frame onto the first one so two frames captured either side of a
 * settle window can be compared for real change. The running card's spinner advances on its own
 * 90 ms timer (`use-spinner-frame.ts`), so a raw whole-frame equality flaps for a reason that has
 * nothing to do with the key under test. Derived from `glyphs.spinner` rather than a literal glyph
 * run, so re-picking the spinner palette can't silently re-introduce the flake.
 */
const SPINNER_STANDIN = glyphs.spinner[0] ?? '⠋';
const withoutSpinnerFrames = (frame: string): string =>
  glyphs.spinner.reduce((acc, glyph) => acc.split(glyph).join(SPINNER_STANDIN), frame);

describe('TasksPanel — u unblock chord', () => {
  it('fires onUnblock with the focused card id when it is blocked', async () => {
    const onUnblock = vi.fn<(taskId: string) => void>();
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        blockedTaskIds={new Set(['task-blocked'])}
        onUnblock={onUnblock}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Cursor defaults to the active (running) card — move up onto the blocked one first.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write('u');
    await waitForPredicate(() => onUnblock.mock.calls.length === 1);

    expect(onUnblock).toHaveBeenCalledWith('task-blocked');
    r.unmount();
  });

  it('is inert on a focused card that is not in blockedTaskIds', async () => {
    const onUnblock = vi.fn<(taskId: string) => void>();
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        blockedTaskIds={new Set(['task-blocked'])}
        onUnblock={onUnblock}
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Cursor stays on the active card (task-live), which is NOT in blockedTaskIds.
    r.stdin.write('u');
    await tick(50);

    expect(onUnblock).not.toHaveBeenCalled();
    r.unmount();
  });

  it('is inert when the host wires no handler', async () => {
    const r = render(
      <TasksPanel bucketed={bucketed()} running={true} inputActive={true} blockedTaskIds={new Set(['task-blocked'])} />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Move onto the blocked card first, THEN snapshot — the move itself legitimately changes
    // the frame (cursor caret), so `before` must be captured after settling on the target card.
    r.stdin.write(UP);
    await tick(30);
    const before = withoutSpinnerFrames(r.lastFrame() ?? '');

    r.stdin.write('u');
    await tick(50);

    // With no `onUnblock` there is nothing to observe but the frame, so the assertion is "the
    // panel did not react" — spinner animation normalised out on both sides.
    expect(withoutSpinnerFrames(r.lastFrame() ?? '')).toBe(before);
    r.unmount();
  });
});

describe('TasksPanel — e criteria toggle anchors on the focused card', () => {
  it('expands the criteria of the card the cursor moved to, not the active task', async () => {
    const r = render(
      <TasksPanel
        bucketed={bucketed()}
        running={true}
        inputActive={true}
        taskCriteriaById={
          new Map([
            ['task-blocked', ['Blocked-1', 'Blocked-2', 'Blocked-3', 'Blocked-4 hidden until e']],
            ['task-live', ['Live-1', 'Live-2', 'Live-3', 'Live-4 hidden until e']],
          ])
        }
      />
    );
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('task-liv'));

    // Move the card cursor off the active task onto the blocked one, expand THAT card (Enter —
    // the criteria block only renders inside an expanded card at all), then press `e`.
    r.stdin.write(UP);
    await tick(30);
    r.stdin.write(ENTER);
    await tick(30);
    r.stdin.write('e');
    await tick(40);
    const frame = r.lastFrame() ?? '';

    // The FOCUSED card's (task-blocked) 4th bullet is now visible…
    expect(frame).toContain('Blocked-4 hidden until e');
    // …while the ACTIVE card's (task-live) 4th bullet stays collapsed — proving `e` targeted the
    // focused card, not unconditionally the active one (the pre-fix behaviour).
    expect(frame).not.toContain('Live-4 hidden until e');
    r.unmount();
  });
});

describe('TasksPanelHost — u from the Execute panel asks about a rejected diff in git stash', () => {
  it('opens the prior-work question and writes the answer once the run has settled', async () => {
    const sprint = makeActiveSprint();
    const marked = markTaskBlocked(makeTodoTask({ name: 'Add retry' }), 'budget gone', 'own', {
      blockCause: 'budget-exhausted',
    });
    if (!marked.ok) throw new Error(marked.error.message);
    const task = marked.value;
    const updated: Task[] = [];
    const queue = createPromptQueue();
    const deps = {
      sprintRepo: {
        findById: async () => Result.ok(sprint),
        list: async () => Result.ok([sprint]),
        save: async () => Result.ok(undefined),
      },
      taskRepo: {
        findBySprintId: async () => Result.ok([task]),
        update: async (_id: SprintId, t: Task) => {
          updated.push(t);
          return Result.ok(undefined);
        },
        saveAll: async () => Result.ok(undefined),
      },
      projectRepo: { findById: async () => Result.ok(makeProject()) },
      gitRunner: stashRunner({
        subject: `On main: ${quarantineStashMessage(sprint.id, task.id)}`,
        numstat: ['5\t1\tsrc/a.ts'],
      }),
      clock: () => IsoTimestamp.now(),
      logger: noopLogger,
    } as unknown as AppDeps;
    const descriptor: SessionDescriptor = {
      id: 'sess-1',
      flowId: 'implement',
      title: 'Sprint',
      status: 'completed',
      startedAt: 0,
      trace: [],
      pinnedSprintId: sprint.id,
    };

    const { result } = renderView(
      <>
        <TasksPanelHost
          bucketed={{
            tasks: [
              { id: String(task.id), status: 'blocked', subSteps: [], evaluations: [], signals: [], genEvalRound: 0 },
            ],
            orphanSignals: [],
          }}
          descriptor={descriptor}
          isRunning={false}
          maxSignalsPerTask={8}
          maxTasks={10}
          inputActive={true}
          now={0}
          taskState={[task]}
        />
        <PromptHost queue={queue} />
      </>,
      { deps, initial: { id: 'sprints' }, queue }
    );
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('blocked'));
    await tick(50);
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('what should its next attempt do'));
    expect(updated).toHaveLength(0);

    result.stdin.write(ENTER);
    await waitForPredicate(() => updated.length === 1);
    expect(updated[0]?.status).toBe('todo');
    expect(updated[0]?.quarantinedDiff?.nextAttempt).toBe('fresh');
  });
});
