import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import {
  buildSprintRequirementsAggregate,
  renderSprintRequirementsMarkdown,
  serialiseSprintRequirementsAggregate,
} from './sprint-requirements-aggregate.ts';
import { ExportRequirementsUseCase } from './export-requirements.ts';

const NOW = IsoTimestamp.trustString('2026-04-29T12:00:00.000Z');
const NOW_DATE = new Date('2026-04-29T12:00:00.000Z');

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
      title: 'Add feature X',
      description: 'A short description',
    })
  );
  sprint = unwrap(sprint.addTicket(ticket));
  return sprint;
}

function approveAllTickets(sprint: Sprint, requirementsBody: string): Sprint {
  let next = sprint;
  for (const ticket of sprint.tickets) {
    const approved = unwrap(ticket.approveRequirements(requirementsBody));
    next = unwrap(next.replaceTicket(ticket.id, approved));
  }
  return next;
}

describe('renderSprintRequirementsMarkdown', () => {
  it('renders a sprint header + approved ticket sections', () => {
    const sprint = approveAllTickets(buildSprint(), '## Detailed\n\nGo do the thing.');
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    const md = renderSprintRequirementsMarkdown(agg);
    expect(md).toContain('# Requirements — Sprint A');
    expect(md).toContain('- Project: demo');
    expect(md).toContain('## Add feature X');
    expect(md).toContain('Go do the thing.');
  });

  it('renders sprint-level affected repositories when set', () => {
    let sprint = approveAllTickets(buildSprint(), '## R\n\nbody');
    sprint = unwrap(sprint.setAffectedRepositories([AbsolutePath.trustString('/tmp/demo-repo')]));
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    const md = renderSprintRequirementsMarkdown(agg);
    expect(md).toContain('- Affected repositories:');
    expect(md).toContain('  - `/tmp/demo-repo`');
  });

  it('omits tickets that are not approved', () => {
    // Sprint where the ticket stays pending → aggregate filters it out.
    const sprint = buildSprint();
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    expect(agg.tickets).toHaveLength(0);
    const md = renderSprintRequirementsMarkdown(agg);
    expect(md).toContain('no approved ticket requirements yet');
    expect(md).not.toContain('## Add feature X');
  });

  it('handles empty ticket list', () => {
    const sprint = unwrap(
      Sprint.create({
        name: 'Empty',
        slug: unwrap(Slug.parse('empty')),
        now: NOW,
        projectName: unwrap(ProjectName.parse('demo')),
      })
    );
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    const md = renderSprintRequirementsMarkdown(agg);
    expect(md).toContain('# Requirements — Empty');
    expect(md).toContain('no approved ticket requirements yet');
  });
});

describe('ExportRequirementsUseCase', () => {
  it('reads the JSON aggregate, renders markdown, and writes to the requested output path', async () => {
    const sprint = approveAllTickets(buildSprint(), '## R\n\nbody');
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    const aggregateBody = serialiseSprintRequirementsAggregate(agg);

    let writtenPath: string | undefined;
    let writtenBody: string | undefined;
    const writeFile = (path: string, body: string): Promise<void> => {
      writtenPath = path;
      writtenBody = body;
      return Promise.resolve();
    };
    const readFile = (): Promise<string> => Promise.resolve(aggregateBody);
    const uc = new ExportRequirementsUseCase(writeFile, readFile);

    const output = AbsolutePath.trustString('/tmp/requirements.md');
    const result = await uc.execute({
      aggregatePath: AbsolutePath.trustString('/tmp/requirements.json'),
      outputPath: output,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(output);
    expect(result.value.byteCount).toBeGreaterThan(0);
    expect(writtenPath).toBe('/tmp/requirements.md');
    expect(writtenBody).toContain('# Requirements — Sprint A');
    expect(writtenBody).toContain('body');
  });

  it('surfaces a missing aggregate file as ValidationError', async () => {
    const readFile = (): Promise<string> => Promise.reject(new Error('ENOENT'));
    const uc = new ExportRequirementsUseCase(() => Promise.resolve(), readFile);

    const result = await uc.execute({
      aggregatePath: AbsolutePath.trustString('/tmp/requirements.json'),
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('requirements aggregate not found');
      expect(result.error.message).toContain('sprint refine');
    }
  });

  it('surfaces JSON parse failures as ValidationError', async () => {
    const readFile = (): Promise<string> => Promise.resolve('{ this is not json');
    const uc = new ExportRequirementsUseCase(() => Promise.resolve(), readFile);

    const result = await uc.execute({
      aggregatePath: AbsolutePath.trustString('/tmp/requirements.json'),
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('failed to parse');
    }
  });

  it('surfaces filesystem write failures as ValidationError', async () => {
    const sprint = approveAllTickets(buildSprint(), '## R\n\nbody');
    const agg = buildSprintRequirementsAggregate(sprint, NOW_DATE);
    const aggregateBody = serialiseSprintRequirementsAggregate(agg);
    const readFile = (): Promise<string> => Promise.resolve(aggregateBody);
    const writeFile = (): Promise<void> => Promise.reject(new Error('disk full'));
    const uc = new ExportRequirementsUseCase(writeFile, readFile);

    const result = await uc.execute({
      aggregatePath: AbsolutePath.trustString('/tmp/requirements.json'),
      outputPath: AbsolutePath.trustString('/tmp/x.md'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('disk full');
    }
  });
});
