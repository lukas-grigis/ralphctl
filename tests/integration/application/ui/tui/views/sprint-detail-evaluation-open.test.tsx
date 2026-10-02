/**
 * Sprint-detail — the `v` chord that opens the focused task's evaluation verdict.
 *
 * The overlay itself is covered in `components/evaluation-overlay*.test.tsx`; this file pins the
 * VIEW's half of the contract: which rows the chord answers on and what it hands over. The
 * pre-existing keymap rows it was appended after (`d` remove-ticket, `u` unblock) keep their own
 * fences in `sprint-detail-view.test.tsx` and the unblock suite — appending, rather than
 * inserting, is what keeps those green.
 *
 * A probe surfaces `ui.evaluationTarget` as text so the assertion is on the state the overlay
 * consumes, not on the overlay's rendering.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { recordRunningAttemptEvaluation, startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTodoTask } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-eval-fixture' as unknown as SprintId;
const ATTEMPT_STARTED_AT = '2026-08-17T09:00:00.000Z' as IsoTimestamp;

const makeTicket = (id: string, title: string): unknown => ({
  id,
  title,
  status: 'approved',
  description: `${title} description`,
  requirements: `requirements for ${title}`,
});

const makeSprint = (): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'eval-sprint',
    name: 'Eval Sprint',
    projectId: 'proj-fixture' as never,
    status: 'planned',
    tickets: [makeTicket('ticket-a', 'alpha card')],
  }) as unknown as Sprint;

const evaluatedTask = (name: string, file: string): Task => {
  const started = startNextAttempt(makeTodoTask({ name }), ATTEMPT_STARTED_AT, 'session-1');
  if (!started.ok) throw new Error(`fixture: ${started.error.message}`);
  const evaluated = recordRunningAttemptEvaluation(started.value, { status: 'failed', file });
  if (!evaluated.ok) throw new Error(`fixture: ${evaluated.error.message}`);
  return evaluated.value;
};

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

/** Surfaces the overlay's target as a one-line sentinel: `TARGET:<taskLabel>:<attemptN>:<file>`. */
const TargetProbe = (): React.JSX.Element => {
  const ui = useUiState();
  const t = ui.evaluationTarget;
  if (t === undefined) return <Text>TARGET:none</Text>;
  return (
    <Text>
      TARGET:{t.taskLabel}:{String(t.attemptN)}:{t.status}:{t.file ?? 'no-file'}
    </Text>
  );
};

const renderDetail = (tasks: readonly Task[]): ReturnType<typeof renderView> =>
  renderView(
    <>
      <TargetProbe />
      <SprintDetailView />
    </>,
    { deps: stubDeps(makeSprint(), tasks), initial }
  );

describe('SprintDetailView — `v` opens the focused task evaluation', () => {
  it('opens on a task that recorded a verdict, handing over the full target', async () => {
    const task = evaluatedTask('wire the migration', 'rounds/2/evaluator/evaluation.md');
    const { result } = renderDetail([task]);
    await waitForViewReady(result, (f) => f.includes('wire the migration'));

    // Cursor starts on the single ticket row; one step down lands on the task.
    result.stdin.write('j');
    await tick(40);
    result.stdin.write('v');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('TARGET:wire the migration'));

    expect(result.lastFrame() ?? '').toContain('TARGET:wire the migration:1:failed:rounds/2/evaluator/evaluation.md');
    result.unmount();
  });

  it('hands over a target with no file for a legacy row that recorded no artifact path', async () => {
    const task = evaluatedTask('legacy task', '');
    const { result } = renderDetail([task]);
    await waitForViewReady(result, (f) => f.includes('legacy task'));

    result.stdin.write('j');
    await tick(40);
    result.stdin.write('v');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('TARGET:legacy task'));

    // The chord still opens — the overlay owns the degrade, not the view.
    expect(result.lastFrame() ?? '').toContain('TARGET:legacy task:1:failed:no-file');
    result.unmount();
  });

  it('is inert while the cursor is on a ticket row', async () => {
    const task = evaluatedTask('wire the migration', 'rounds/2/evaluator/evaluation.md');
    const { result } = renderDetail([task]);
    await waitForViewReady(result, (f) => f.includes('alpha card'));

    // No `j` — the cursor is still on the ticket.
    result.stdin.write('v');
    await tick(60);
    expect(result.lastFrame() ?? '').toContain('TARGET:none');
    result.unmount();
  });

  it('is inert on a task whose attempts never reached the evaluator', async () => {
    const { result } = renderDetail([makeTodoTask({ name: 'never evaluated' })]);
    await waitForViewReady(result, (f) => f.includes('never evaluated'));

    result.stdin.write('j');
    await tick(40);
    result.stdin.write('v');
    await tick(60);
    expect(result.lastFrame() ?? '').toContain('TARGET:none');
    result.unmount();
  });

  it('advertises the chord in the static action bar', async () => {
    // The action bar is static copy (like `↵/o expand`), so it names `v` unconditionally; the
    // per-focus gating lives in the FOOTER hint, which `buildDetailHints` drives off
    // `focusedEvaluatedTask`. Pinning the bar keeps the affordance discoverable.
    const task = evaluatedTask('wire the migration', 'rounds/2/evaluator/evaluation.md');
    const { result } = renderDetail([task]);
    await waitForViewReady(result, (f) => f.includes('wire the migration'));
    expect(result.lastFrame() ?? '').toContain('v evaluation');
    result.unmount();
  });
});
