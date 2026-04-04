import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestEnvironment } from '@src/test-utils/setup.ts';
import { captureOutput, createTestEnv } from '@src/test-utils/setup.ts';

let testEnv: TestEnvironment;

beforeEach(async () => {
  testEnv = await createTestEnv();
  process.env['RALPHCTL_ROOT'] = testEnv.testDir;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await testEnv.cleanup();
});

describe('sprint health checks', () => {
  it('checkTicketsWithoutTasks warns for active sprint with approved orphans', async () => {
    const { createSprint, activateSprint, getSprint, saveSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { setCurrentSprint } = await import('@src/store/config.ts');

    const sprint = await createSprint('Health Test');
    const ticket = await addTicket({ title: 'Orphaned Ticket', projectName: 'test-project' }, sprint.id);

    // Approve the ticket's requirements manually
    const loaded = await getSprint(sprint.id);
    const t = loaded.tickets.find((tk) => tk.id === ticket.id);
    if (t) t.requirementStatus = 'approved';
    await saveSprint(loaded);

    await activateSprint(sprint.id);
    await setCurrentSprint(sprint.id);

    // The health command should run without errors — we verify the check logic directly
    // by importing the module and checking console output would contain 'fail'
    // For unit-level verification, we test the function output indirectly
    const { sprintHealthCommand } = await import('./health.ts');

    const output = await captureOutput(() => sprintHealthCommand());

    // The health output should mention the orphaned ticket
    expect(output).toContain('Orphaned Ticket');
    expect(output).toContain('Tickets Without Tasks');
  });

  it('checkPendingRequirementsOnActive warns for pending tickets on active sprint', async () => {
    const { createSprint, activateSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { setCurrentSprint } = await import('@src/store/config.ts');

    const sprint = await createSprint('Pending Test');
    await addTicket({ title: 'Pending Ticket', projectName: 'test-project' }, sprint.id);
    await activateSprint(sprint.id);
    await setCurrentSprint(sprint.id);

    const { sprintHealthCommand } = await import('./health.ts');

    const output = await captureOutput(() => sprintHealthCommand());

    expect(output).toContain('Pending Requirements');
    expect(output).toContain('Pending Ticket');
  });

  it('checkDuplicateOrders detects tasks with same order', async () => {
    const { createSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { addTask, getTasks, saveTasks } = await import('@src/store/task.ts');
    const { setCurrentSprint } = await import('@src/store/config.ts');

    const sprint = await createSprint('Dup Order Test');
    const ticket = await addTicket({ title: 'Ticket', projectName: 'test-project' }, sprint.id);
    await addTask({ name: 'Task A', ticketId: ticket.id, projectPath: testEnv.projectDir }, sprint.id);
    await addTask({ name: 'Task B', ticketId: ticket.id, projectPath: testEnv.projectDir }, sprint.id);

    // Manually set both tasks to order 1 to create a duplicate
    const tasks = await getTasks(sprint.id);
    for (const t of tasks) {
      t.order = 1;
    }
    await saveTasks(tasks, sprint.id);

    await setCurrentSprint(sprint.id);

    const { sprintHealthCommand } = await import('./health.ts');

    const output = await captureOutput(() => sprintHealthCommand());

    expect(output).toContain('Duplicate Task Orders');
    expect(output).toContain('Order 1');
  });
});
