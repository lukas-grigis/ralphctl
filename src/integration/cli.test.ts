/**
 * Integration tests for ralphctl services.
 * Tests real file I/O with isolated temp directories.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestEnvironment } from '@src/test-utils/setup.ts';
import { createTestEnv } from '@src/test-utils/setup.ts';

// Set RALPHCTL_ROOT before importing services
let testEnv: TestEnvironment;
let testDir: string;
let projectDir: string;

beforeEach(async () => {
  testEnv = await createTestEnv();
  testDir = testEnv.testDir;
  projectDir = testEnv.projectDir;
  process.env['RALPHCTL_ROOT'] = testDir;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await testEnv.cleanup();
});

describe('Project Service', () => {
  it('creates and lists projects', async () => {
    const { listProjects, createProject, getProject } = await import('@src/store/project.ts');

    // Already have test-project from beforeEach
    const projects = await listProjects();
    expect(projects.length).toBe(1);
    expect(projects[0]?.name).toBe('test-project');

    // Create new project
    const newProjectDir = await mkdtemp(join(tmpdir(), 'ralphctl-proj2-'));
    try {
      const project = await createProject({
        name: 'new-project',
        displayName: 'New Project',
        repositories: [{ name: 'new-project', path: newProjectDir }],
      });
      expect(project.name).toBe('new-project');

      // Verify persisted
      const loaded = await getProject('new-project');
      expect(loaded.displayName).toBe('New Project');
    } finally {
      await rm(newProjectDir, { recursive: true, force: true });
    }
  });

  it('adds and removes repos from project', async () => {
    const { addProjectRepo, removeProjectRepo, getProject, ProjectNotFoundError } =
      await import('@src/store/project.ts');

    // Create a second repo directory
    const newPath = await mkdtemp(join(tmpdir(), 'ralphctl-repo-'));
    try {
      // Add repo
      const updated = await addProjectRepo('test-project', { name: 'test-repo', path: newPath });
      expect(updated.repositories.map((r) => r.path)).toContain(newPath);
      expect(updated.repositories.length).toBe(2);

      // Verify persisted
      const loaded = await getProject('test-project');
      expect(loaded.repositories.length).toBe(2);

      // Remove repo
      const afterRemove = await removeProjectRepo('test-project', newPath);
      expect(afterRemove.repositories.length).toBe(1);
      expect(afterRemove.repositories.map((r) => r.path)).not.toContain(newPath);

      // Cannot remove last repo
      await expect(removeProjectRepo('test-project', projectDir)).rejects.toThrow(
        'Cannot remove the last repository from a project'
      );

      // ProjectNotFoundError for nonexistent project
      await expect(addProjectRepo('nonexistent', { name: 'test-repo', path: newPath })).rejects.toThrow(
        ProjectNotFoundError
      );
    } finally {
      await rm(newPath, { recursive: true, force: true });
    }
  });

  it('validates paths exist', async () => {
    const { addProjectRepo } = await import('@src/store/project.ts');

    await expect(
      addProjectRepo('test-project', { name: 'bad-repo', path: '/nonexistent/path/abc123' })
    ).rejects.toThrow('Invalid path');
  });
});

describe('Sprint Service', () => {
  it('creates, activates, and closes sprint', async () => {
    // Dynamic import after env is set
    const { createSprint, getSprint, activateSprint, closeSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { addTask, updateTaskStatus } = await import('@src/store/task.ts');

    // Create
    const sprint = await createSprint('Test Sprint');
    expect(sprint.name).toBe('Test Sprint');
    expect(sprint.status).toBe('draft');

    // Add ticket and task (in draft sprint)
    const ticket1 = await addTicket({ title: 'Test', projectName: 'test-project' }, sprint.id);
    const task = await addTask({ name: 'Task 1', ticketId: ticket1.id, projectPath: projectDir }, sprint.id);

    // Activate
    const activated = await activateSprint(sprint.id);
    expect(activated.status).toBe('active');

    // Update task status to done (only allowed in active sprint)
    await updateTaskStatus(task.id, 'done', sprint.id);

    // Close
    const closed = await closeSprint(sprint.id);
    expect(closed.status).toBe('closed');

    // Verify persisted
    const loaded = await getSprint(sprint.id);
    expect(loaded.status).toBe('closed');
  });
});

describe('Ticket Service', () => {
  it('adds, lists, and removes tickets', async () => {
    const { createSprint } = await import('@src/store/sprint.ts');
    const { addTicket, listTickets, removeTicket, getTicket } = await import('@src/store/ticket.ts');

    const sprint = await createSprint('Ticket Test');

    // Add
    const ticket = await addTicket(
      {
        title: 'Fix Bug',
        description: 'Details',
        projectName: 'test-project',
      },
      sprint.id
    );
    expect(ticket.title).toBe('Fix Bug');
    expect(ticket.id).toBeDefined(); // Auto-generated internal ID

    // List
    const tickets = await listTickets(sprint.id);
    expect(tickets.length).toBe(1);
    expect(tickets[0]?.title).toBe('Fix Bug');

    // Get by internal ID
    const fetched = await getTicket(ticket.id, sprint.id);
    expect(fetched.title).toBe('Fix Bug');

    // Remove
    await removeTicket(ticket.id, sprint.id);
    const afterRemove = await listTickets(sprint.id);
    expect(afterRemove.length).toBe(0);
  });
});

describe('Task Service', () => {
  it('adds, updates status, and removes tasks', async () => {
    const { createSprint, activateSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { addTask, listTasks, updateTaskStatus, getTask } = await import('@src/store/task.ts');

    const sprint = await createSprint('Task Test');
    const ticket = await addTicket({ title: 'Ticket', projectName: 'test-project' }, sprint.id);

    // Add task (in draft sprint)
    const task = await addTask({ name: 'My Task', ticketId: ticket.id, projectPath: projectDir }, sprint.id);
    expect(task.name).toBe('My Task');
    expect(task.status).toBe('todo');

    // List
    const tasks = await listTasks(sprint.id);
    expect(tasks.length).toBe(1);

    // Activate sprint to allow status updates
    await activateSprint(sprint.id);

    // Update status (only in active sprint)
    const updated = await updateTaskStatus(task.id, 'in_progress', sprint.id);
    expect(updated.status).toBe('in_progress');

    // Get
    const fetched = await getTask(task.id, sprint.id);
    expect(fetched.status).toBe('in_progress');

    // Note: Remove task is only allowed in draft sprints, so we can't test it here
  });

  it('handles task dependencies via topological sort', async () => {
    const { createSprint } = await import('@src/store/sprint.ts');
    const { addTicket } = await import('@src/store/ticket.ts');
    const { addTask, reorderByDependencies, listTasks } = await import('@src/store/task.ts');

    const sprint = await createSprint('Deps Test');
    const ticket = await addTicket({ title: 'Ticket', projectName: 'test-project' }, sprint.id);

    // Create tasks with dependencies: C -> B -> A
    const taskA = await addTask({ name: 'A', ticketId: ticket.id, projectPath: projectDir }, sprint.id);
    const taskB = await addTask(
      { name: 'B', ticketId: ticket.id, projectPath: projectDir, blockedBy: [taskA.id] },
      sprint.id
    );
    await addTask({ name: 'C', ticketId: ticket.id, projectPath: projectDir, blockedBy: [taskB.id] }, sprint.id);

    await reorderByDependencies(sprint.id);

    const sorted = await listTasks(sprint.id);
    const names = sorted.map((t) => t.name);

    // A should come before B, B before C
    expect(names.indexOf('A')).toBeLessThan(names.indexOf('B'));
    expect(names.indexOf('B')).toBeLessThan(names.indexOf('C'));
  });
});

describe('Error Handling', () => {
  it('throws on sprint not found', async () => {
    const { getSprint, SprintNotFoundError } = await import('@src/store/sprint.ts');

    await expect(getSprint('nonexistent')).rejects.toThrow(SprintNotFoundError);
  });

  it('allows multiple active sprints', async () => {
    const { createSprint, activateSprint, getSprint } = await import('@src/store/sprint.ts');

    // Create and activate first sprint
    const sprint1 = await createSprint('Sprint 1');
    await activateSprint(sprint1.id);
    expect((await getSprint(sprint1.id)).status).toBe('active');

    // Create and activate second sprint
    const sprint2 = await createSprint('Sprint 2');
    await activateSprint(sprint2.id);

    // Both sprints should be active (can run in parallel terminals)
    expect((await getSprint(sprint1.id)).status).toBe('active');
    expect((await getSprint(sprint2.id)).status).toBe('active');
  });

  it('throws on ticket not found', async () => {
    const { createSprint } = await import('@src/store/sprint.ts');
    const { getTicket, TicketNotFoundError } = await import('@src/store/ticket.ts');

    const sprint = await createSprint('Test');
    await expect(getTicket('nonexistent', sprint.id)).rejects.toThrow(TicketNotFoundError);
  });

  it('throws on task not found', async () => {
    const { createSprint } = await import('@src/store/sprint.ts');
    const { getTask, TaskNotFoundError } = await import('@src/store/task.ts');

    const sprint = await createSprint('Test');
    await expect(getTask('nonexistent', sprint.id)).rejects.toThrow(TaskNotFoundError);
  });
});
