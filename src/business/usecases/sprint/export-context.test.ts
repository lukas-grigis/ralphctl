import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Task } from '@src/domain/entities/task.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { InMemoryProjectRepository } from '@src/business/_test-fakes/in-memory-project-repository.ts';
import { InMemorySprintRepository } from '@src/business/_test-fakes/in-memory-sprint-repository.ts';
import { InMemoryTaskRepository } from '@src/business/_test-fakes/in-memory-task-repository.ts';
import { ExportContextUseCase, renderContextMarkdown } from './export-context.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');

function unwrap<T>(r: { ok: boolean; value?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok: ${String(r.error)}`);
  return r.value as T;
}

function buildSprint(): Sprint {
  let sprint = unwrap(
    Sprint.create({
      name: 'Sprint A',
      slug: unwrap(Slug.parse('sprint-a')),
      now: NOW,
      projectName: unwrap(ProjectName.parse('demo')),
    })
  );
  const ticket = unwrap(
    Ticket.create({
      title: 'Implement feature',
    })
  );
  sprint = unwrap(sprint.addTicket(ticket));
  return sprint;
}

function buildProject(): Project {
  const repo = unwrap(
    Repository.create({
      path: AbsolutePath.trustString('/tmp/demo-repo'),
      checkScript: 'pnpm test',
    })
  );
  return unwrap(
    Project.create({
      name: unwrap(ProjectName.parse('demo')),
      displayName: 'Demo project',
      description: 'A demo description',
      repositories: [repo],
    })
  );
}

function buildTask(name: string): Task {
  return unwrap(
    Task.create({
      name,
      steps: ['step-1', 'step-2'],
      verificationCriteria: ['criterion-1'],
      order: 1,
      projectPath: AbsolutePath.trustString('/tmp/demo-repo'),
    })
  );
}

describe('renderContextMarkdown', () => {
  it('includes sprint summary, projects, tickets, and tasks sections', () => {
    const sprint = buildSprint();
    const project = buildProject();
    const task = buildTask('Implement feature');
    const md = renderContextMarkdown({
      sprint,
      tasks: [task],
      projects: [project],
    });
    expect(md).toContain('# Harness Context — Sprint A');
    expect(md).toContain('## Projects');
    expect(md).toContain('### demo — Demo project');
    expect(md).toContain('## Tickets');
    expect(md).toContain('Implement feature');
    expect(md).toContain('## Tasks');
    expect(md).toContain('### 1. Implement feature');
    expect(md).toContain('pnpm test');
  });

  it('includes "(no tasks)" placeholder when no tasks exist', () => {
    const sprint = buildSprint();
    const md = renderContextMarkdown({ sprint, tasks: [], projects: [buildProject()] });
    expect(md).toContain('(no tasks generated yet');
  });

  it('handles empty everything', () => {
    const sprint = unwrap(
      Sprint.create({
        name: 'Empty',
        slug: unwrap(Slug.parse('empty')),
        now: NOW,
        projectName: unwrap(ProjectName.parse('demo')),
      })
    );
    const md = renderContextMarkdown({ sprint, tasks: [], projects: [] });
    expect(md).toContain('# Harness Context — Empty');
    expect(md).toContain('(no projects registered)');
    expect(md).toContain('(no tickets)');
  });
});

describe('ExportContextUseCase', () => {
  it('writes a populated context file', async () => {
    const sprint = buildSprint();
    const project = buildProject();
    const task = buildTask('Implement feature');
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository([[sprint.id, [task]]]);
    const projectRepo = new InMemoryProjectRepository([project]);
    let writtenPath: string | undefined;
    let writtenBody: string | undefined;
    const writeFile = (p: string, b: string): Promise<void> => {
      writtenPath = p;
      writtenBody = b;
      return Promise.resolve();
    };
    const uc = new ExportContextUseCase(sprintRepo, taskRepo, projectRepo, writeFile);

    const output = AbsolutePath.trustString('/tmp/context.md');
    const result = await uc.execute({ sprintId: sprint.id, outputPath: output });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.byteCount).toBeGreaterThan(0);
    expect(writtenPath).toBe('/tmp/context.md');
    expect(writtenBody).toContain('# Harness Context — Sprint A');
    expect(writtenBody).toContain('Implement feature');
  });

  it('returns NotFoundError for missing sprint', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository();
    const taskRepo = new InMemoryTaskRepository();
    const projectRepo = new InMemoryProjectRepository();
    const uc = new ExportContextUseCase(sprintRepo, taskRepo, projectRepo, () => Promise.resolve());

    const result = await uc.execute({
      sprintId: sprint.id,
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
  });

  it('surfaces write failures as a domain error', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const taskRepo = new InMemoryTaskRepository();
    const projectRepo = new InMemoryProjectRepository();
    const uc = new ExportContextUseCase(sprintRepo, taskRepo, projectRepo, () =>
      Promise.reject(new Error('write failed'))
    );

    const result = await uc.execute({
      sprintId: sprint.id,
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('write failed');
    }
  });
});
