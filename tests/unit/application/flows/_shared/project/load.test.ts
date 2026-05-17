import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { makeProject } from '@tests/fixtures/domain.ts';
import { type LoadProjectCtx, loadProjectLeaf } from '@src/application/flows/_shared/project/load.ts';

const fakeRepo = (project: Project | undefined): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (project && project.id === id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

describe('loadProjectLeaf', () => {
  it('loads the project and writes it onto ctx', async () => {
    const project = makeProject();
    const el = loadProjectLeaf<LoadProjectCtx>({ projectRepo: fakeRepo(project) });

    const result = await el.execute({ projectId: project.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ctx.project).toBe(project);
      expect(result.value.trace).toHaveLength(1);
      expect(result.value.trace[0]?.elementName).toBe('load-project');
      expect(result.value.trace[0]?.status).toBe('completed');
    }
  });

  it('surfaces NotFoundError as a failed trace entry', async () => {
    const project = makeProject();
    const el = loadProjectLeaf<LoadProjectCtx>({ projectRepo: fakeRepo(undefined) });

    const result = await el.execute({ projectId: project.id });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error).toBeInstanceOf(NotFoundError);
      expect(result.error.trace[0]?.status).toBe('failed');
    }
  });

  it('honours a custom name for chains that load multiple projects', async () => {
    const project = makeProject();
    const el = loadProjectLeaf<LoadProjectCtx>({ projectRepo: fakeRepo(project) }, 'reload-project');

    const result = await el.execute({ projectId: project.id });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.trace[0]?.elementName).toBe('reload-project');
  });
});
