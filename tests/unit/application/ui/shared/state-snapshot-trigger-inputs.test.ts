/**
 * Producer side of `TriggerInputs.blockedTaskCount`.
 *
 * `registry-triggers.test.ts` already pins the CONSUMER — `evaluateTriggers` branching the
 * `minResumableTasks` failure sentence on the field. That suite hand-builds its inputs, so it
 * stayed green while `computeTriggerInputs` never set the field at all and the all-blocked
 * sentence could not fire on any real snapshot. These cases close that seam: they drive
 * `loadAppStateSnapshot` from stubbed repos and feed its own `triggerInputs` straight into
 * `evaluateTriggers`, so the wiring — not just the branch — is covered.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { evaluateTriggers } from '@src/application/registry-triggers.ts';
import { implementManifest } from '@src/application/flows/implement/manifest.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import type { BlockedTask, Task } from '@src/domain/entity/task.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

const blockedTask = (name: string): BlockedTask => {
  const r = markTaskBlocked(makeTodoTask({ name }), 'stuck', 'own');
  if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
  return r.value;
};

const makeDeps = (project: Project, sprint: Sprint, tasks: readonly Task[]) => ({
  projectRepo: {
    async findById() {
      return Result.ok(project);
    },
    async list() {
      return Result.ok([project]);
    },
  } as unknown as ProjectRepository,
  sprintRepo: {
    async findById() {
      return Result.ok(sprint);
    },
    async list() {
      return Result.ok([sprint]);
    },
  } as unknown as SprintRepository,
  taskRepo: {
    async findBySprintId() {
      return Result.ok([...tasks]);
    },
  } as unknown as TaskRepository,
});

const loadWith = async (tasks: readonly Task[]) => {
  const project = makeProject({ displayName: 'Snapshot Project' });
  const sprint = { ...makeActiveSprint(), projectId: project.id } as unknown as Sprint;
  return loadAppStateSnapshot(makeDeps(project, sprint, tasks), { projectId: project.id, sprintId: sprint.id });
};

describe('loadAppStateSnapshot — triggerInputs.blockedTaskCount', () => {
  it('sets the count from the loaded task list', async () => {
    const snapshot = await loadWith([blockedTask('one'), blockedTask('two'), makeTodoTask({ name: 'runnable' })]);

    expect(snapshot.triggerInputs.blockedTaskCount).toBe(2);
    expect(snapshot.triggerInputs.resumableTaskCount).toBe(1);
  });

  it('reports zero when nothing is blocked', async () => {
    const snapshot = await loadWith([makeTodoTask({ name: 'runnable' })]);

    expect(snapshot.triggerInputs.blockedTaskCount).toBe(0);
  });

  it('an all-blocked sprint reaches evaluateTriggers as the "unblock one" sentence, not "run Plan first"', async () => {
    // The end-to-end shape the Flows menu actually renders: snapshot in, manifest triggers
    // evaluated against that snapshot's own triggerInputs, sentence out. This is the assertion
    // that fails when `computeTriggerInputs` stops setting the field.
    const snapshot = await loadWith([blockedTask('one'), blockedTask('two')]);

    const result = evaluateTriggers(implementManifest.triggers ?? {}, snapshot.triggerInputs);

    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toBe('Every remaining task is blocked — unblock one to make it runnable again.');
    }
  });

  it('an empty task list still reaches the "run Plan first" sentence', async () => {
    const snapshot = await loadWith([]);

    const result = evaluateTriggers(implementManifest.triggers ?? {}, snapshot.triggerInputs);

    expect(result.enabled).toBe(false);
    if (!result.enabled) {
      expect(result.reason).toContain('run Plan first');
    }
  });
});
