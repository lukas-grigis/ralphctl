/**
 * Sprints-list bulk `u` with rejected diffs in git stash: one multi-choice over the tasks that have a stash,
 * the recommended-continue rows pre-ticked, one decision applied per task, and a mixed toast. Esc unblocks nothing.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { PromptHost } from '@src/application/ui/tui/prompts/prompt-host.tsx';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { quarantineStashMessage } from '@src/domain/value/quarantine-stash-message.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { ENTER, ESC } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { stashEntriesRunner } from '@tests/fixtures/stash-runner.ts';

const flat = (frame: string): string => frame.replace(/\s+/g, ' ');

const blocked = (name: string, order: number, cause: 'generator-self-block' | 'budget-exhausted'): Task => {
  const r = markTaskBlocked(makeTodoTask({ name, order }), `${name} stopped`, 'own', { blockCause: cause });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const setup = () => {
  const sprint = makeActiveSprint();
  const asked = blocked('Add retry', 1, 'generator-self-block');
  const budget = blocked('Parse headers', 2, 'budget-exhausted');
  const updated: Task[] = [];
  const queue = createPromptQueue();
  const deps = {
    sprintRepo: {
      list: async () => Result.ok([sprint]),
      findById: async () => Result.ok(sprint),
      save: async () => Result.ok(undefined),
    },
    taskRepo: {
      findBySprintId: async () => Result.ok([asked, budget]),
      update: async (_id: SprintId, t: Task) => {
        updated.push(t);
        return Result.ok(undefined);
      },
      saveAll: async () => Result.ok(undefined),
    },
    projectRepo: { findById: async () => Result.ok(makeProject()) },
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    gitRunner: stashEntriesRunner([
      { subject: `On main: ${quarantineStashMessage(sprint.id, asked.id)}`, numstat: ['5\t1\tsrc/a.ts'] },
      { subject: `On main: ${quarantineStashMessage(sprint.id, budget.id)}`, numstat: ['2\t0\tsrc/b.ts'] },
    ]),
    clock: () => IsoTimestamp.now(),
    logger: noopLogger,
  } as unknown as AppDeps;
  const { result } = renderView(
    <>
      <SprintsView />
      <PromptHost queue={queue} />
    </>,
    { deps, initial: { id: 'sprints' }, queue }
  );
  return { updated, result, asked, budget };
};

const openQuestion = async (result: ReturnType<typeof setup>['result']): Promise<void> => {
  await waitForViewReady(result, (f) => f.includes('unblock'));
  result.stdin.write('u');
  await waitForPredicate(() => (result.lastFrame() ?? '').includes('left a rejected diff in git stash'));
};

describe('SprintsView — bulk u with rejected diffs in git stash', () => {
  it('asks one multi-choice with the recommended-continue row ticked', async () => {
    const { result, updated } = setup();
    await openQuestion(result);

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Unblock 2 stuck tasks — 2 left a rejected diff in git stash.');
    expect(frame).toMatch(/\[✓\]\s*Add retry — 1 file \+5 -1 · stopped for a missing answer/);
    expect(frame).toMatch(/\[ \]\s*Parse headers — 1 file \+2 -0 · Parse headers stopped/);
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    expect(updated).toHaveLength(0);
  });

  it('↵ applies the ticked decision per task and reports the mix', async () => {
    const { result, updated, asked, budget } = setup();
    await openQuestion(result);
    result.stdin.write(ENTER);
    await waitForPredicate(() => /unblocked 2 tasks/.test(result.lastFrame() ?? ''));

    const byId = new Map(updated.map((t) => [String(t.id), t]));
    expect(byId.get(String(asked.id))?.quarantinedDiff?.nextAttempt).toBe('continue');
    expect(byId.get(String(budget.id))?.quarantinedDiff?.nextAttempt).toBe('fresh');
    expect(flat(result.lastFrame() ?? '')).toContain(
      '1 continues from its rejected diff, 1 starts fresh (diff kept in git stash)'
    );
  });

  it('esc unblocks nothing', async () => {
    const { result, updated } = setup();
    await openQuestion(result);
    result.stdin.write(ESC);
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblock cancelled'));

    expect(updated).toHaveLength(0);
    expect(flat(result.lastFrame() ?? '')).toContain('i unblock cancelled — nothing was unblocked');
  });
});
