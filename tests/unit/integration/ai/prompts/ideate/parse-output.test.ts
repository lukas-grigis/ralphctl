import { describe, expect, it } from 'vitest';
import { parseIdeateOutput } from '@src/integration/ai/prompts/ideate/parse-output.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { FIXTURE_REPO_PATH, makeApprovedTicket, makeProject } from '@tests/fixtures/domain.ts';

const ticketId = (() => {
  const r = TicketId.parse('01900000-0000-7000-8000-00000000aaaa');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const sprintId = (() => {
  const r = SprintId.parse('01900000-0000-7000-8000-00000000bbbb');
  if (!r.ok) throw new Error('test setup');
  return r.value;
})();

const project = makeProject(); // single repo at FIXTURE_REPO_PATH

describe('parseIdeateOutput', () => {
  it('happy path: parses requirements + tasks, resolves projectPath, sets ticketId on each', () => {
    const json = JSON.stringify({
      requirements: '## Problem\nfoo\n\n## AC\n- given … then …',
      tasks: [
        {
          id: '1',
          name: 'Add CSV export',
          description: 'wire it up',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['add schema', 'wire controller'],
          verificationCriteria: [{ id: 'C1', assertion: 'tests pass', check: 'manual' }],
          blockedBy: [],
        },
        {
          id: '2',
          name: 'Add UI button',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['add component'],
          verificationCriteria: [{ id: 'C1', assertion: 'button visible', check: 'manual' }],
          blockedBy: ['1'],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.requirements).toContain('## Problem');
    expect(out.value.tasks).toHaveLength(2);
    expect(out.value.tasks[0]?.name).toBe('Add CSV export');
    expect(out.value.tasks[0]?.ticketId).toBe(ticketId);
    expect(out.value.tasks[0]?.repositoryId).toBe(project.repositories[0]?.id);
    expect(out.value.tasks[1]?.dependsOn).toHaveLength(1);
    expect(out.value.tasks[1]?.dependsOn?.[0]).toBe(out.value.tasks[0]?.id);
  });

  it('rejects malformed JSON', () => {
    const out = parseIdeateOutput('{not json', { project, sprintId, ticketId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.subCode).toBe('invalid-json');
  });

  it('rejects when requirements is missing', () => {
    const out = parseIdeateOutput(JSON.stringify({ tasks: [] }), { project, sprintId, ticketId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.subCode).toBe('schema-mismatch');
  });

  it('rejects when tasks is not an array', () => {
    const out = parseIdeateOutput(JSON.stringify({ requirements: 'r', tasks: 'oops' }), {
      project,
      sprintId,
      ticketId,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.subCode).toBe('schema-mismatch');
  });

  it('rejects when projectPath is not in the project repos', () => {
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          name: 'X',
          projectPath: '/some/unknown/path',
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain('not in the project');
  });

  it('rejects when blockedBy references unknown id', () => {
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          id: '1',
          name: 'X',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
          blockedBy: ['ghost'],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.message).toContain('unknown task id');
  });

  it('rejects task with empty steps', () => {
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          name: 'X',
          projectPath: FIXTURE_REPO_PATH,
          steps: [],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(false);
  });

  it('accepts empty tasks array (planning gave up but requirements stand)', () => {
    const json = JSON.stringify({ requirements: 'whatever', tasks: [] });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.tasks).toHaveLength(0);
  });

  it('inherits externalRef from the supplied source ticket onto every generated task', () => {
    const ticket = makeApprovedTicket({ externalRef: 'PROJ-7' });
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          name: 'A',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
        {
          name: 'B',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId: ticket.id, ticket });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks[0]?.externalRefs).toEqual(['PROJ-7']);
    expect(out.value.tasks[1]?.externalRefs).toEqual(['PROJ-7']);
  });

  it('omits externalRefs when the source ticket has no externalRef (caller passes ticket)', () => {
    const ticket = makeApprovedTicket();
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          name: 'A',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId: ticket.id, ticket });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks[0]?.externalRefs).toBeUndefined();
  });

  it('omits externalRefs when no source ticket is supplied (legacy id-only call)', () => {
    const json = JSON.stringify({
      requirements: 'r',
      tasks: [
        {
          name: 'A',
          projectPath: FIXTURE_REPO_PATH,
          steps: ['s'],
          verificationCriteria: [{ id: 'C1', assertion: 'v', check: 'manual' }],
        },
      ],
    });
    const out = parseIdeateOutput(json, { project, sprintId, ticketId });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.tasks[0]?.externalRefs).toBeUndefined();
  });
});
