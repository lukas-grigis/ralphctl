/**
 * Behavior 3 — `loadAppStateSnapshot` recentSprints excludes done sprints.
 *
 * The Home view renders recentSprints as inline switch items. Including `status: 'done'`
 * sprints clutters the list with finished work — the design decision is to exclude them so
 * the inline picker only surfaces actionable sprints (draft / active / review / planned).
 *
 * When the implementer lands the done-filter, `recentSprints` must contain zero `done` entries
 * regardless of how many done sprints are in storage.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Project } from '@src/domain/entity/project.ts';
import { makeProject, makeDraftSprint, makeReviewSprint, makeDoneSprint } from '@tests/fixtures/domain.ts';

// ── Repo stubs ────────────────────────────────────────────────────────────────

const makeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById() {
      return Result.ok(project);
    },
    async list() {
      return Result.ok([project]);
    },
  }) as unknown as ProjectRepository;

const makeSprintRepo = (sprints: readonly Sprint[]): SprintRepository =>
  ({
    async findById() {
      return Result.error({ code: 'not-found', message: 'no selected sprint', name: 'NotFoundError' } as never);
    },
    async list() {
      return Result.ok([...sprints]);
    },
  }) as unknown as SprintRepository;

const emptyTaskRepo = (): TaskRepository =>
  ({
    async findBySprintId() {
      return Result.ok([]);
    },
  }) as unknown as TaskRepository;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('loadAppStateSnapshot — recentSprints excludes done', () => {
  it('excludes done sprints from recentSprints even when present in storage', async () => {
    const project = makeProject({ displayName: 'Test Project' });
    const done1 = makeDoneSprint();
    const done2 = makeDoneSprint();
    const review = makeReviewSprint();
    const draft = makeDraftSprint();

    // Force all sprints to belong to this project so they get grouped together.
    const sprints: Sprint[] = [
      { ...done1, projectId: project.id } as unknown as Sprint,
      { ...done2, projectId: project.id } as unknown as Sprint,
      { ...review, projectId: project.id } as unknown as Sprint,
      { ...draft, projectId: project.id } as unknown as Sprint,
    ];

    const deps = {
      projectRepo: makeProjectRepo(project),
      sprintRepo: makeSprintRepo(sprints),
      taskRepo: emptyTaskRepo(),
    };

    const snapshot = await loadAppStateSnapshot(deps, { projectId: project.id });

    const doneInRecent = snapshot.recentSprints.filter((s) => s.status === 'done');
    expect(doneInRecent).toHaveLength(0);
  });

  it('retains non-done sprints in recentSprints', async () => {
    const project = makeProject({ displayName: 'Active Project' });
    const done = makeDoneSprint();
    const review = makeReviewSprint();
    const draft = makeDraftSprint();

    const sprints: Sprint[] = [
      { ...done, projectId: project.id } as unknown as Sprint,
      { ...review, projectId: project.id } as unknown as Sprint,
      { ...draft, projectId: project.id } as unknown as Sprint,
    ];

    const deps = {
      projectRepo: makeProjectRepo(project),
      sprintRepo: makeSprintRepo(sprints),
      taskRepo: emptyTaskRepo(),
    };

    const snapshot = await loadAppStateSnapshot(deps, { projectId: project.id });

    const nonDone = snapshot.recentSprints.filter((s) => s.status !== 'done');
    // We expect review and draft to be in recentSprints, not done.
    expect(nonDone.length).toBeGreaterThanOrEqual(2);
    // None of the retained entries should be done.
    expect(snapshot.recentSprints.every((s) => s.status !== 'done')).toBe(true);
  });

  it('returns empty recentSprints when the only sprints are done', async () => {
    const project = makeProject({ displayName: 'Finished Project' });
    const done1 = makeDoneSprint();
    const done2 = makeDoneSprint();

    const sprints: Sprint[] = [
      { ...done1, projectId: project.id } as unknown as Sprint,
      { ...done2, projectId: project.id } as unknown as Sprint,
    ];

    const deps = {
      projectRepo: makeProjectRepo(project),
      sprintRepo: makeSprintRepo(sprints),
      taskRepo: emptyTaskRepo(),
    };

    const snapshot = await loadAppStateSnapshot(deps, { projectId: project.id });

    expect(snapshot.recentSprints).toHaveLength(0);
  });

  it('returns empty recentSprints when no sprints exist at all', async () => {
    const project = makeProject({ displayName: 'Empty Project' });

    const deps = {
      projectRepo: makeProjectRepo(project),
      sprintRepo: makeSprintRepo([]),
      taskRepo: emptyTaskRepo(),
    };

    const snapshot = await loadAppStateSnapshot(deps, { projectId: project.id });

    expect(snapshot.recentSprints).toHaveLength(0);
  });
});
