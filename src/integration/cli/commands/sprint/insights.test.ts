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

describe('sprint insights', () => {
  it('prints evaluation report for sprint with evaluated tasks', async () => {
    const { createSprint, activateSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { addTask, getTasks, saveTasks } = await import('@src/integration/persistence/task.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint({ projectId: testEnv.projectId, name: 'Insights Test' });
    const ticket = await addTicket({ title: 'Auth Feature' }, sprint.id);

    // Add tasks while sprint is still draft
    await addTask({ name: 'Add authentication', ticketId: ticket.id, repoId: testEnv.repoId }, sprint.id);
    await addTask({ name: 'Add user profile', ticketId: ticket.id, repoId: testEnv.repoId }, sprint.id);

    await activateSprint(sprint.id);
    await setCurrentSprint(sprint.id);

    // Mark tasks as evaluated with output
    const tasks = await getTasks(sprint.id);
    for (const task of tasks) {
      task.evaluated = true;
      task.status = 'done';
      if (task.name === 'Add authentication') {
        task.evaluationOutput = 'Missing error handling in login function';
      } else {
        task.evaluationOutput = '<evaluation-passed>';
      }
    }
    await saveTasks(tasks, sprint.id);

    const { sprintInsightsCommand } = await import('./insights.ts');
    const output = await captureOutput(() => sprintInsightsCommand([]));

    expect(output).toContain('Tasks evaluated');
    expect(output).toContain('2');
    expect(output).toContain('Add authentication');
  });

  it('prints no-data message when sprint has no evaluations', async () => {
    const { createSprint, activateSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { addTask } = await import('@src/integration/persistence/task.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint({ projectId: testEnv.projectId, name: 'No Eval Test' });
    const ticket = await addTicket({ title: 'Some Feature' }, sprint.id);

    // Add task while sprint is still draft
    await addTask({ name: 'Unevaluated task', ticketId: ticket.id, repoId: testEnv.repoId }, sprint.id);

    await activateSprint(sprint.id);
    await setCurrentSprint(sprint.id);

    const { sprintInsightsCommand } = await import('./insights.ts');
    const output = await captureOutput(() => sprintInsightsCommand([]));

    expect(output).toContain('No evaluation data');
  });

  it('shows error when no current sprint is set', async () => {
    const { sprintInsightsCommand } = await import('./insights.ts');
    const output = await captureOutput(() => sprintInsightsCommand([]));

    expect(output).toContain('no current sprint');
  });

  it('uses sprint-id argument when provided', async () => {
    const { createSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { addTask, getTasks, saveTasks } = await import('@src/integration/persistence/task.ts');

    const sprint = await createSprint({ projectId: testEnv.projectId, name: 'Specific Sprint' });
    const ticket = await addTicket({ title: 'Feature' }, sprint.id);
    await addTask({ name: 'Task with eval', ticketId: ticket.id, repoId: testEnv.repoId }, sprint.id);

    const tasks = await getTasks(sprint.id);
    for (const task of tasks) {
      task.evaluated = true;
      task.evaluationOutput = 'Some critique';
    }
    await saveTasks(tasks, sprint.id);

    const { sprintInsightsCommand } = await import('./insights.ts');
    const output = await captureOutput(() => sprintInsightsCommand([sprint.id]));

    expect(output).toContain('Specific Sprint');
    expect(output).toContain('Task with eval');
  });

  it('exports insights when --export flag is set', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { createSprint, activateSprint } = await import('@src/integration/persistence/sprint.ts');
    const { addTicket } = await import('@src/integration/persistence/ticket.ts');
    const { addTask, getTasks, saveTasks } = await import('@src/integration/persistence/task.ts');
    const { setCurrentSprint } = await import('@src/integration/persistence/config.ts');

    const sprint = await createSprint({ projectId: testEnv.projectId, name: 'Export Test' });
    const ticket = await addTicket({ title: 'Export Feature' }, sprint.id);

    // Add task while sprint is still draft
    await addTask({ name: 'Evaluated task', ticketId: ticket.id, repoId: testEnv.repoId }, sprint.id);

    await activateSprint(sprint.id);
    await setCurrentSprint(sprint.id);

    const tasks = await getTasks(sprint.id);
    for (const task of tasks) {
      task.evaluated = true;
      task.evaluationOutput = 'Needs better error handling';
      task.status = 'done';
    }
    await saveTasks(tasks, sprint.id);

    const { sprintInsightsCommand } = await import('./insights.ts');
    const output = await captureOutput(() => sprintInsightsCommand(['--export']));

    expect(output).toContain('Insights exported');

    // Verify the exported file exists and has correct content (uses RALPHCTL_ROOT data dir)
    const exportPath = join(testEnv.testDir, 'insights', `${sprint.id}.md`);
    const content = await readFile(exportPath, 'utf-8');
    expect(content).toContain('# Sprint Insights: Export Test');
    expect(content).toContain('Evaluated task');
    expect(content).toContain('Needs better error handling');
  });
});
