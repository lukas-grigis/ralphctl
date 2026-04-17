import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestEnvironment } from '@src/test-utils/setup.ts';
import { createTestEnv } from '@src/test-utils/setup.ts';

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = testEnv.testDir;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await testEnv.cleanup();
});

describe('ideate: stale sprint overwrite regression', () => {
  it('addTicket ticket survives subsequent saveSprint with re-read', async () => {
    // Reproduces the bug where:
    // 1. sprint loaded (tickets: [])
    // 2. addTicket() loads its own copy, pushes ticket, saves (tickets: [ticket])
    // 3. saveSprint(stale) overwrites with tickets: []
    //
    // The fix: re-read sprint after addTicket() before saving further changes.

    const { createSprint, getSprint, saveSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint('Ideate Overwrite Test');
    await setCurrentSprint(sprint.id);

    // Step 1: Load sprint (stale reference)
    const staleSprint = await getSprint(sprint.id);
    expect(staleSprint.tickets).toHaveLength(0);

    // Step 2: addTicket saves its own copy with the new ticket
    const ticket = await addTicket({ title: 'My Idea', projectName: 'test-project' }, sprint.id);

    // Verify ticket was persisted
    const afterAdd = await getSprint(sprint.id);
    expect(afterAdd.tickets).toHaveLength(1);
    expect(afterAdd.tickets[0]?.id).toBe(ticket.id);

    // Step 3 (THE BUG): saving the stale reference would wipe the ticket
    // staleSprint.tickets is still [] — saving it would destroy the ticket
    expect(staleSprint.tickets).toHaveLength(0);

    // Step 3 (THE FIX): re-read sprint before modifying and saving
    const freshSprint = await getSprint(sprint.id);
    const freshTicket = freshSprint.tickets.find((t) => t.id === ticket.id);
    expect(freshTicket).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by assertion above
    freshTicket!.affectedRepositories = [testEnv.projectDir];
    await saveSprint(freshSprint);

    // Verify ticket survived with affectedRepositories set
    const final = await getSprint(sprint.id);
    expect(final.tickets).toHaveLength(1);
    expect(final.tickets[0]?.id).toBe(ticket.id);
    expect(final.tickets[0]?.affectedRepositories).toEqual([testEnv.projectDir]);
  });

  it('demonstrates the bug: stale saveSprint wipes ticket', async () => {
    // This test documents exactly what the bug did — saving a stale
    // sprint reference after addTicket() destroys the ticket.

    const { createSprint, getSprint, saveSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint('Bug Demo');
    await setCurrentSprint(sprint.id);

    // Load sprint (this will become stale)
    const staleSprint = await getSprint(sprint.id);

    // addTicket saves its own fresh copy
    await addTicket({ title: 'Doomed Ticket', projectName: 'test-project' }, sprint.id);

    // Saving the stale reference wipes the ticket (the bug)
    await saveSprint(staleSprint);

    const result = await getSprint(sprint.id);
    // This is the broken state — ticket is gone
    expect(result.tickets).toHaveLength(0);
  });
});

describe('parseIdeateOutput', () => {
  it('parses valid ideate output with requirements and tasks', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    const output = JSON.stringify({
      requirements: '## Problem\nNeed visible likes\n\n## Requirements\n- Show likers',
      tasks: [
        {
          id: '1',
          name: 'Add liker summary',
          projectPath: '/repo/web',
          steps: ['Step 1', 'Step 2'],
          blockedBy: [],
        },
      ],
    });

    const result = parseIdeateOutput(output);
    expect(result.requirements).toContain('visible likes');
    expect(result.tasks).toHaveLength(1);
  });

  it('handles bare tasks array without requirements wrapper', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    // This is what the AI wrote in the bug scenario — a bare array
    const output = JSON.stringify([
      {
        id: '1',
        name: 'Add liker summary',
        projectPath: '/repo/web',
        steps: ['Step 1'],
        blockedBy: [],
      },
    ]);

    const result = parseIdeateOutput(output);
    expect(result.requirements).toBe('');
    expect(result.tasks).toHaveLength(1);
  });

  it('throws when output contains neither object nor array', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');
    expect(() => parseIdeateOutput('just some random text')).toThrow('No valid ideate output found');
  });

  it('parses JSON object embedded in markdown code block', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    const inner = JSON.stringify({
      requirements: '## Problem\nTest',
      tasks: [{ id: '1', name: 'T1', projectPath: '/repo', steps: [], blockedBy: [] }],
    });
    const output = '```json\n' + inner + '\n```';

    const result = parseIdeateOutput(output);
    expect(result.requirements).toContain('Test');
    expect(result.tasks).toHaveLength(1);
  });

  it('parses JSON object embedded in surrounding prose', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    const inner = JSON.stringify({
      requirements: 'reqs',
      tasks: [{ id: '1', name: 'T', projectPath: '/r', steps: [], blockedBy: [] }],
    });
    const output = 'Here is the output:\n\n' + inner + '\n\nDone!';

    const result = parseIdeateOutput(output);
    expect(result.requirements).toBe('reqs');
    expect(result.tasks).toHaveLength(1);
  });

  it('falls back to bare array when object fails schema validation', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    // wrong_field instead of requirements — object parses but fails IdeateOutputSchema
    const output = JSON.stringify({
      wrong_field: 'x',
      tasks: [{ id: '1', name: 'T', projectPath: '/r', steps: [], blockedBy: [] }],
    });

    const result = parseIdeateOutput(output);
    expect(result.requirements).toBe('');
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('throws on empty string input', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');
    expect(() => parseIdeateOutput('')).toThrow('No valid ideate output found');
  });

  it('throws with schema details when object has no tasks array', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    const output = JSON.stringify({ wrong_field: 'x', other: 'y' });

    expect(() => parseIdeateOutput(output)).toThrow('Invalid ideate output format');
  });

  it('empty requirements in wrapper object triggers fallback', async () => {
    const { parseIdeateOutput } = await import('./ideate.ts');

    // IdeateOutputSchema has z.string().min(1), so empty string fails validation
    const output = JSON.stringify({
      requirements: '',
      tasks: [{ id: '1', name: 'T', projectPath: '/r', steps: [], blockedBy: [] }],
    });

    const result = parseIdeateOutput(output);
    expect(result.requirements).toBe('');
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
  });
});

interface TestImportTask {
  id?: string;
  name: string;
  projectPath: string;
  steps: string[];
  blockedBy: string[];
  ticketId?: string;
}

describe('ticketId auto-assign', () => {
  it('assigns ticketId to tasks without one', () => {
    const tasks: TestImportTask[] = [
      { id: '1', name: 'Task A', projectPath: '/repo', steps: [], blockedBy: [] },
      { id: '2', name: 'Task B', projectPath: '/repo', steps: [], blockedBy: [] },
    ];
    const ticketId = 'ticket-abc';

    for (const task of tasks) {
      task.ticketId ??= ticketId;
    }

    expect(tasks[0]?.ticketId).toBe('ticket-abc');
    expect(tasks[1]?.ticketId).toBe('ticket-abc');
  });

  it('does not overwrite ticketId already set on tasks', () => {
    const tasks: TestImportTask[] = [
      { id: '1', name: 'Task A', projectPath: '/repo', steps: [], blockedBy: [], ticketId: 'original-id' },
      { id: '2', name: 'Task B', projectPath: '/repo', steps: [], blockedBy: [] },
    ];
    const newTicketId = 'new-id';

    for (const task of tasks) {
      task.ticketId ??= newTicketId;
    }

    expect(tasks[0]?.ticketId).toBe('original-id');
    expect(tasks[1]?.ticketId).toBe('new-id');
  });
});
