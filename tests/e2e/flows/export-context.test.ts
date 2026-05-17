import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { FindTasksBySprintId } from '@src/domain/repository/task/find-tasks-by-sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import {
  absolutePath,
  FIXED_PROJECT_ID,
  makeApprovedTicket,
  makeDraftSprint,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { createExportContextFlow } from '@src/application/flows/export-context/flow.ts';

const fakeSprintRepo = (sprint: Sprint): SprintRepository =>
  ({
    async findById(id: SprintId) {
      if (id === sprint.id) return Result.ok(sprint);
      return Result.error(new NotFoundError({ entity: 'sprint', id: String(id) }));
    },
  }) as SprintRepository;

const fakeProjectRepo = (project: Project): ProjectRepository =>
  ({
    async findById(id: ProjectId) {
      if (id === project.id) return Result.ok(project);
      return Result.error(new NotFoundError({ entity: 'project', id: String(id) }));
    },
  }) as ProjectRepository;

const fakeTaskRepo = (tasks: readonly Task[]): FindTasksBySprintId => ({
  async findBySprintId() {
    return Result.ok(tasks);
  },
});

const inMemoryWriteFile = (): { writeFile: WriteFile; writes: Array<{ path: AbsolutePath; content: string }> } => {
  const writes: Array<{ path: AbsolutePath; content: string }> = [];
  const writeFile: WriteFile = async (path, content) => {
    writes.push({ path, content });
    return Result.ok(undefined);
  };
  return { writeFile, writes };
};

describe('export-context flow — happy path', () => {
  it('renders sprint + project + tasks and writes the markdown', async () => {
    const project = makeProject({ id: FIXED_PROJECT_ID, displayName: 'Demo' });
    const ticket = makeApprovedTicket({ title: 'login bug' });
    const sprint = makeDraftSprint({ projectId: project.id, tickets: [ticket] });
    const tasks = [makeTodoTask({ name: 'wire form', order: 1 })];
    const writer = inMemoryWriteFile();
    const outputPath = absolutePath('/tmp/ctx.md');

    const flow = createExportContextFlow({
      sprintRepo: fakeSprintRepo(sprint),
      projectRepo: fakeProjectRepo(project),
      taskRepo: fakeTaskRepo(tasks),
      writeFile: writer.writeFile,
    });
    const result = await flow.execute({ input: { sprintId: sprint.id, projectId: project.id, outputPath } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ctx.output!.outputPath).toBe(outputPath);
    expect(writer.writes).toHaveLength(1);
    const body = writer.writes[0]?.content ?? '';
    expect(body).toContain('# Harness Context — sprint-1');
    expect(body).toContain('### Demo');
    expect(body).toContain('### login bug');
    expect(body).toContain('### 1. wire form');
  });

  it('surfaces NotFoundError when the project does not exist', async () => {
    const project = makeProject({ id: FIXED_PROJECT_ID });
    const sprint = makeDraftSprint({ projectId: project.id, tickets: [] });
    const writer = inMemoryWriteFile();

    const flow = createExportContextFlow({
      sprintRepo: fakeSprintRepo(sprint),
      projectRepo: fakeProjectRepo(project),
      taskRepo: fakeTaskRepo([]),
      writeFile: writer.writeFile,
    });
    const result = await flow.execute({
      input: {
        sprintId: sprint.id,
        projectId: 'missing' as unknown as ProjectId,
        outputPath: absolutePath('/tmp/x.md'),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBeInstanceOf(NotFoundError);
    expect(writer.writes).toHaveLength(0);
  });
});
