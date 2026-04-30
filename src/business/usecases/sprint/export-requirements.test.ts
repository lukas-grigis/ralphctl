import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { InMemorySprintRepository } from '../../_test-fakes/in-memory-sprint-repository.ts';
import { ExportRequirementsUseCase, renderRequirementsMarkdown } from './export-requirements.ts';

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
    })
  );
  const ticket1 = unwrap(
    Ticket.create({
      title: 'Add feature X',
      description: 'A short description',
      projectName: unwrap(ProjectName.parse('demo')),
    })
  );
  sprint = unwrap(sprint.addTicket(ticket1));
  return sprint;
}

describe('renderRequirementsMarkdown', () => {
  it('renders a sprint header + ticket sections', () => {
    const sprint = buildSprint();
    const md = renderRequirementsMarkdown(sprint);
    expect(md).toContain('# Requirements — Sprint A');
    expect(md).toContain('## Add feature X');
    expect(md).toContain('Project: demo');
    expect(md).toContain('Requirement status: pending');
  });

  it('shows "(not yet refined)" for tickets with no requirements', () => {
    const sprint = buildSprint();
    const md = renderRequirementsMarkdown(sprint);
    expect(md).toContain('not yet refined');
  });

  it('renders refined requirements verbatim', () => {
    let sprint = buildSprint();
    const ticket = sprint.tickets[0];
    if (!ticket) throw new Error('precondition failed');
    const refined = unwrap(ticket.approveRequirements('## Detailed requirements\n\nGo do the thing.'));
    sprint = unwrap(sprint.replaceTicket(ticket.id, refined));
    const md = renderRequirementsMarkdown(sprint);
    expect(md).toContain('Go do the thing.');
    expect(md).not.toContain('not yet refined');
  });

  it('handles empty ticket list', () => {
    const sprint = unwrap(
      Sprint.create({
        name: 'Empty',
        slug: unwrap(Slug.parse('empty')),
        now: NOW,
      })
    );
    const md = renderRequirementsMarkdown(sprint);
    expect(md).toContain('# Requirements — Empty');
    expect(md).toContain('(no tickets)');
  });
});

describe('ExportRequirementsUseCase', () => {
  it('writes the markdown to the requested output path', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository([sprint]);
    let writtenPath: string | undefined;
    let writtenBody: string | undefined;
    const writeFile = (path: string, body: string): Promise<void> => {
      writtenPath = path;
      writtenBody = body;
      return Promise.resolve();
    };
    const uc = new ExportRequirementsUseCase(sprintRepo, writeFile);

    const output = AbsolutePath.trustString('/tmp/requirements.md');
    const result = await uc.execute({ sprintId: sprint.id, outputPath: output });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(output);
    expect(result.value.byteCount).toBeGreaterThan(0);
    expect(writtenPath).toBe('/tmp/requirements.md');
    expect(writtenBody).toContain('# Requirements — Sprint A');
  });

  it('returns NotFoundError for an unknown sprint', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository();
    const uc = new ExportRequirementsUseCase(sprintRepo, () => Promise.resolve());

    const result = await uc.execute({
      sprintId: sprint.id,
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
  });

  it('surfaces filesystem write failures as ValidationError', async () => {
    const sprint = buildSprint();
    const sprintRepo = new InMemorySprintRepository([sprint]);
    const writeFile = (): Promise<void> => Promise.reject(new Error('disk full'));
    const uc = new ExportRequirementsUseCase(sprintRepo, writeFile);

    const result = await uc.execute({
      sprintId: sprint.id,
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('disk full');
    }
  });
});
