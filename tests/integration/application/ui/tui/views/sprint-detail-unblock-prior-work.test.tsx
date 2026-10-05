/**
 * Sprint-detail `u` on a blocked task whose rejected diff sits in git stash: the operator is asked what the
 * next attempt does with it (through the real prompt queue + host), the answer is persisted on the task, and
 * Esc writes nothing. Git is scripted — only the stash listing matters here.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { DOWN, ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { stashRunner } from '@tests/fixtures/stash-runner.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

const sprint: Sprint = makeActiveSprint();
const project = makeProject();

const blockedTask = (): Task => {
  const r = markTaskBlocked(makeTodoTask({ name: 'Add retry' }), 'attempt budget exhausted (maxAttempts=3)', 'own', {
    blockCause: 'budget-exhausted',
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

const setup = () => {
  const task = blockedTask();
  const updated: Task[] = [];
  const queue = createPromptQueue();
  const deps = {
    sprintRepo: {
      findById: async () => Result.ok(sprint),
      list: async () => Result.ok([sprint]),
      save: async () => Result.ok(undefined),
    },
    taskRepo: {
      findBySprintId: async () => Result.ok([updated.at(-1) ?? task]),
      update: async (_id: SprintId, t: Task) => {
        updated.push(t);
        return Result.ok(undefined);
      },
      saveAll: async () => Result.ok(undefined),
    },
    projectRepo: { findById: async () => Result.ok(project) },
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    gitRunner: stashRunner({
      subject: `On main: ${quarantineStashMessage(sprint.id, task.id)}`,
      numstat: ['88\t21\tsrc/http/client.ts', '41\t0\tsrc/http/retry.ts', '-\t-\tdocs/retry-flow.png'],
    }),
    clock: () => IsoTimestamp.now(),
    logger: noopLogger,
  } as unknown as AppDeps;
  const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: sprint.id } };
  const { result } = renderView(
    <>
      <SprintDetailView />
      <PromptHost queue={queue} />
    </>,
    { deps, initial, queue }
  );
  return { task, updated, result };
};

const openQuestion = async (result: ReturnType<typeof setup>['result']): Promise<void> => {
  await waitForViewReady(result, (f) => f.includes('Add retry'));
  result.stdin.write('j');
  await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
  result.stdin.write('u');
  await waitForPredicate(() => (result.lastFrame() ?? '').includes('what should its next attempt do'));
};

describe('SprintDetailView — u asks about the rejected diff in git stash', () => {
  it('renders the question at 100 columns with the recommended option first', async () => {
    const { result, updated } = setup();
    await openQuestion(result);

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Unblock "Add retry" — what should its next attempt do with the rejected diff?');
    expect(frame).toContain('kept in git stash:');
    expect(frame).toContain('3 files +129 -21');
    expect(frame).toContain('suggested: start fresh');
    expect(frame).toContain('PgUp/PgDn');
    expect(frame.indexOf('Start fresh')).toBeLessThan(frame.indexOf('Continue from it'));
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    expect(updated).toHaveLength(0);
  });

  it('↵ on Start fresh persists nextAttempt fresh and says so', async () => {
    const { result, updated } = setup();
    await openQuestion(result);
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('next attempt starts fresh'));

    expect(updated[0]?.status).toBe('todo');
    expect(updated[0]?.quarantinedDiff?.nextAttempt).toBe('fresh');
    expect(flat(result.lastFrame() ?? '')).toContain(
      '✓ unblocked "Add retry" — next attempt starts fresh; its rejected diff stays in git stash'
    );
  });

  it('↓↵ picks Continue and persists it with the stat', async () => {
    const { result, updated } = setup();
    await openQuestion(result);
    result.stdin.write(DOWN);
    await tick(30);
    result.stdin.write(ENTER);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('continues from its rejected diff'));

    expect(updated[0]?.quarantinedDiff?.nextAttempt).toBe('continue');
    expect(flat(result.lastFrame() ?? '')).toContain(
      '✓ unblocked "Add retry" — next attempt continues from its rejected diff (3 files +129 -21)'
    );
  });

  it('esc writes nothing and shows the cancel toast', async () => {
    const { result, updated } = setup();
    await openQuestion(result);
    result.stdin.write(ESC);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblock cancelled'));

    expect(updated).toHaveLength(0);
    expect(flat(result.lastFrame() ?? '')).toContain('i unblock cancelled — "Add retry" is still blocked');
  });
});
